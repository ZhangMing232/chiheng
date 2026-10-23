/**
 * 这个文件是干什么的：
 * 自媒体图文的内容层：**体裁系统**。以前是 6 个固定内容类型各拉一份数据、
 * 共用一套文案 prompt，所以生成的东西怎么看都像套公式。现在分成两层：
 * **体裁（genre）决定图文形态和文案写法，数据源（topic）决定写什么**。
 *
 * 体裁 × 数据源矩阵（全部用项目里已有的真数据）：
 * - ranking 榜单：个股净流入/净流出、板块净流入/净流出 → 排名列表版式
 * - hotmoney 游资：席位净买（带买了啥）→ 排名列表版式
 * - event 事件：快讯深读（用户点一条）→ 事件卡版式
 * - recap 复盘：指数 + 涨跌分布 + 涨跌停 → 大数字版式
 * - sentiment 情绪：连板梯队 → 梯队条版式
 *
 * 你需要知道的：
 * - 每种体裁有**自己的文案指令段**（榜单怎么甩数、事件怎么解读、游资怎么追、
 *   复盘怎么收、情绪怎么描），共用底层铁律（不荐股、不编、去 AI 套话）。
 * - 支持用户补一句自己的观点（extra），AI 负责自然融进去，不抢戏。
 * - 不绑定单一形态：图由 spec.layout 走四种版式（studio-poster.ts）。
 */

import { loadIndices, loadUniverse } from "./quotes.functions.ts";
import { loadFlow } from "./flow.ts";
import { loadNews } from "./news.ts";
import { loadHotMoney } from "./hotmoney.ts";
import { marketBreadth } from "./slim-universe.ts";
import { callDSH } from "./chiheng-dsh-client.ts";
import type { FlowBook } from "./flow.ts";
import type { HotBook } from "./hotmoney.ts";
import type { NewsItem } from "./news.ts";
import type { IndexQuote } from "./types.ts";
import type { Breadth } from "./slim-universe.ts";
import {
  studioAbsWan,
  studioPct,
  studioTone,
  type StudioDist,
  type StudioItem,
  type StudioMini,
  type StudioSpec,
  type StudioStat,
} from "./studio-poster.ts";

// ── 体裁与数据源 ────────────────────────────────────────────────────

export type StudioGenre = "ranking" | "hotmoney" | "event" | "recap" | "sentiment";
export type StudioPlatform = "douyin" | "wechat";
/** versus 是「一张图讲完一场博弈」：流入流出同图对比（AI 设计管线，studio-ai.ts）。
 *  seats/news/daily/ladder 是单源。 */
export type StudioTopic = "stockVersus" | "sectorVersus" | "seats" | "news" | "daily" | "ladder";

export type GenreDef = {
  id: StudioGenre;
  label: string;
  desc: string;
  topics: { id: StudioTopic; label: string }[];
  /** 默认 top N（榜单类可调 5/10/15） */
  topNOptions: number[];
};

export const GENRES: GenreDef[] = [
  {
    id: "ranking",
    label: "资金流向",
    desc: "一场博弈一张图：流入流出同图对比，红进绿出一眼看清",
    topics: [
      { id: "stockVersus", label: "个股资金流向" },
      { id: "sectorVersus", label: "板块资金流向" },
    ],
    // versus 图条数固定（AI 管线按 TOP8 双边 + 板块 + 两市喂满画幅），不用调
    topNOptions: [1],
  },
  {
    id: "hotmoney",
    label: "游资",
    desc: "席位追踪：谁在买、买了啥，接力思路只摆事实",
    topics: [{ id: "seats", label: "席位净买" }],
    topNOptions: [5, 10, 15],
  },
  {
    id: "event",
    label: "事件",
    desc: "快讯深读：挑一条说清是什么、牵扯什么",
    topics: [{ id: "news", label: "今日快讯" }],
    topNOptions: [1],
  },
  {
    id: "recap",
    label: "复盘",
    desc: "大盘全景：指数、涨跌分布、涨跌停一屏收",
    topics: [{ id: "daily", label: "每日复盘" }],
    topNOptions: [1],
  },
  {
    id: "sentiment",
    label: "情绪",
    desc: "连板天梯：几板有几只，市场情绪的温度计",
    topics: [{ id: "ladder", label: "连板梯队" }],
    topNOptions: [1],
  },
];

export const TOPIC_LABEL: Record<StudioTopic, string> = {
  stockVersus: "个股资金流向对比",
  sectorVersus: "板块资金流向对比",
  seats: "游资席位净买",
  news: "今日热点",
  daily: "今日 A 股",
  ladder: "连板梯队",
};

export function genreOf(id: StudioGenre): GenreDef {
  return GENRES.find((g) => g.id === id) ?? GENRES[0]!;
}

// ── 图：把数据整理成海报规格 ────────────────────────────────────────

export type StudioData = {
  indices: IndexQuote[];
  breadth: Breadth;
  flow: FlowBook | null;
  hotMoney: HotBook | null;
  news: NewsItem[];
  ladder: { streak: number; count: number }[];
  /** 炸板率 %（连板梯队页的补充信息，来自 /signals 的汇总） */
  breakRate: number | null;
};

export type BuildOpts = {
  topN: number;
  /** event 体裁：用户选了哪条快讯（news 数组下标） */
  newsIndex?: number;
};

/**
 * 榜单条目。note 优先用传入的（游资的「买了啥」），否则用涨跌幅——
 * **榜单只给金额不给涨跌幅是信息缺失**：钱进得多但股价跌，是两种完全不同的故事。
 */
function rankingItems(
  rows: { name: string; inflow: number; chg?: number | null }[],
  topN: number,
  note?: (r: { name: string; inflow: number; chg?: number | null }) => string | undefined,
): StudioItem[] {
  return rows.slice(0, topN).map((r) => ({
    name: r.name,
    // **负号必须显式给**：studioAbsWan 内部 Math.abs 吃符号，前缀只给 "+" 的话，
    // 净流出的票在图上会显示成不带负号的正数（2026-10-23 测试逮到的真 bug——
    // 绿字 + 无负号，读者会以为它在流入）。
    value: `${r.inflow > 0 ? "+" : "-"}${studioAbsWan(r.inflow)}`,
    color: studioTone(r.inflow),
    ...(note ? { note: note(r) } : r.chg != null ? { note: studioPct(r.chg) } : {}),
  }));
}

/** 分布条：前 3 名合计 vs 其余合计（单看排名不知道这是不是全部）。 */
function distOf(rows: { inflow: number }[], label: string): StudioDist | undefined {
  if (rows.length < 4) return undefined;
  const top = rows.slice(0, 3).reduce((s, r) => s + r.inflow, 0);
  const rest = rows.slice(3).reduce((s, r) => s + r.inflow, 0);
  return { label, top, rest };
}

/** 底部补充行：涨跌家数（涨红跌绿的事实行）。 */
function breadthNote(b: Breadth): string {
  return `上涨 ${b.up} · 下跌 ${b.down} · 平盘 ${b.flat} · 涨停 ${b.limitUp} · 跌停 ${b.limitDown}`;
}

/** 按体裁 + 数据源生成海报规格。纯函数，页面直接调用。 */
export function buildStudioSpec(genre: StudioGenre, topic: StudioTopic, data: StudioData, opts: BuildOpts): StudioSpec {
  const flow = data.flow;
  switch (topic) {
    case "stockVersus":
      // AI 设计不可用时的模板兜底：流入 / 流出双边拼接在一张图里，
      // 不再拆成「流入一张、流出一张」两张半图（2026-10-23 拍板：同一事实不拆两张）。
      return {
        title: TOPIC_LABEL.stockVersus,
        subtitle: "主力资金 · 流入流出同图对比",
        layout: "ranking",
        items: [
          ...rankingItems(flow?.stocksIn ?? [], opts.topN),
          ...rankingItems(flow?.stocksOut ?? [], opts.topN),
        ],
        footNote: breadthNote(data.breadth),
      };
    case "sectorVersus": {
      // 板块榜的 note 是领涨 / 领跌股（FlowRow.leader）——**板块排名不带龙头是半张图**
      const sectorNote = (side: "in" | "out") => (r: { name: string; inflow: number }) => {
        const pool = side === "in" ? flow?.sectorsIn : flow?.sectorsOut;
        const row = pool?.find((x) => x.name === r.name);
        return row?.leader ? `${side === "in" ? "领涨" : "领跌"} ${row.leader}` : undefined;
      };
      return {
        title: TOPIC_LABEL.sectorVersus,
        subtitle: "板块资金 · 流入流出同图对比",
        layout: "ranking",
        items: [
          ...rankingItems(flow?.sectorsIn ?? [], opts.topN, sectorNote("in")),
          ...rankingItems(flow?.sectorsOut ?? [], opts.topN, sectorNote("out")),
        ],
        footNote: breadthNote(data.breadth),
      };
    }
    case "seats":
      return {
        title: "游资席位净买",
        subtitle: "龙虎榜口径 · 只摆事实",
        layout: "ranking",
        items: rankingItems(
          (data.hotMoney?.seats ?? []).map((s) => ({ name: s.name, inflow: s.netWan })),
          opts.topN,
          (r) => {
            const seat = data.hotMoney?.seats.find((s) => s.name === r.name);
            // 条数纪律：2 只，不是 3 只（图上只给最相关的）
            const names = seat?.stocks.slice(0, 2).map((st) => st.name) ?? [];
            return names.length ? `买了 ${names.join(" · ")}` : undefined;
          },
        ),
        dist: distOf((data.hotMoney?.seats ?? []).map((s) => ({ inflow: s.netWan })), "前 3 席位合计 / 其余全部"),
        footNote: breadthNote(data.breadth),
      };
    case "news": {
      const picked = data.news[opts.newsIndex ?? 0] ?? data.news[0];
      if (!picked) {
        return { title: "今日暂无快讯", layout: "event", body: ["（今天还没抓到快讯，换个时间再试）"], meta: "" };
      }
      const stocks = picked.stocks.slice(0, 4);
      // 涉及票带涨跌幅：只给票名是"提了一嘴"，带涨跌幅才是"这事砸在谁身上"
      const stockText = stocks.map((s) => `${s.name}${s.chg != null ? ` ${studioPct(s.chg)}` : ""}`).join("、");
      // 时间只取 HH:MM（NewsItem.time 有时是完整时间戳，图上写一长串没意义）
      const clock = /(\d{2}:\d{2})/.exec(picked.time)?.[1] ?? picked.time;
      return {
        title: picked.title,
        subtitle: "快讯深读",
        layout: "event",
        meta: `${clock}${stockText ? ` · 涉及 ${stockText}` : ""}`,
        body: [picked.summary || picked.title, ...(stockText ? [`牵扯到的票：${stockText}。`] : [])],
      };
    }
    case "daily": {
      const stats: StudioStat[] = data.indices.slice(0, 4).map((i) => ({
        label: i.name,
        value: i.price.toFixed(2),
        sub: studioPct(i.pct),
        color: studioTone(i.pct),
      }));
      const b = data.breadth;
      // 领涨/领跌板块各 3 条（条数纪律抄 daily_stock_analysis）——数据源同 flow，
      // 板块行自带领涨股名（leader）
      const mini: StudioMini[] = [];
      const inRows = (flow?.sectorsIn ?? []).slice(0, 3);
      if (inRows.length > 0) {
        mini.push({
          title: "资金流入前三",
          rows: inRows.map((r) => ({ name: r.name, value: studioAbsWan(r.inflow), color: studioTone(r.inflow) })),
        });
      }
      const outRows = (flow?.sectorsOut ?? []).slice(0, 3);
      if (outRows.length > 0) {
        mini.push({
          title: "资金流出前三",
          rows: outRows.map((r) => ({ name: r.name, value: studioAbsWan(r.inflow), color: studioTone(r.inflow) })),
        });
      }
      return {
        title: "今日 A 股",
        subtitle: `${b.up + b.down + b.flat} 只在交易`,
        layout: "stat",
        stats,
        breadth: { up: b.up, down: b.down, flat: b.flat, limitUp: b.limitUp, limitDown: b.limitDown },
        ...(mini.length > 0 ? { mini } : {}),
      };
    }
    case "ladder": {
      const rungs = (data.ladder ?? []).filter((r) => r.count > 0).sort((a, b) => a.streak - b.streak);
      const top = rungs.reduce((m, r) => Math.max(m, r.streak), 0);
      return {
        title: "连板梯队",
        subtitle: "几板有几只 · 情绪的温度计",
        layout: "ladder",
        rungs,
        mood: rungs.length
          ? `最高 ${top} 板${data.breakRate != null ? `，炸板率 ${data.breakRate}%` : ""}。梯队越厚，愿意接力的钱越多；只有一根独苗，就是情绪的单兵突进。`
          : "今天没有连板，一板以上的都没有。",
      };
    }
  }
}

/** 海报默认标题（AI 标题失败时的兜底）。 */
export function defaultTitle(topic: StudioTopic): string {
  return TOPIC_LABEL[topic];
}

// ── 文案：每种体裁一套写法 ──────────────────────────────────────────

/** 底层铁律（所有体裁共用）。 */
const RULES = [
  "只写数据里有的，没给的不编；",
  "不给买卖建议（不出现买入/卖出/加仓/抄底/满仓/梭哈）；",
  "禁止这些 AI 套话：今日复盘、综上所述、值得关注、总的来说、值得注意的是、让我们一起、不难发现、可以看出、换言之；",
  "禁止对仗排比和书面连接词（首先/其次/最后/然而/因此少用），长短句错开，像人说话；",
  "数字用具体数：涨跌幅用百分比，金额用亿/万；",
  "标题党可以，但标题里的数字必须是数据里真有的。",
].join("\n");

/** 每种体裁的写法指令（这是去公式化的关键：榜单体≠事件体≠游资体）。 */
export const GENRE_VOICE: Record<StudioGenre, string> = {
  ranking: [
    "你写的是「资金榜单」：开头直接把最炸的那个数字甩出来（谁、多少钱、什么方向），",
    "然后 1-2 句把榜单的走势说清（是齐刷刷进一个方向，还是分歧），",
    "最后一句你的态度（这钱像是在抢还是在撤）。别逐个念名单——图里已经有名单了。",
  ].join("\n"),
  hotmoney: [
    "你写的是「游资追踪」：开头点最猛的那个席位和它的票，",
    "说清这些席位在往哪些票上扎堆、是不是在接力，",
    "提醒一句这只是公开数据的回溯、不是跟着买的理由。别神化游资，也别贬。",
  ].join("\n"),
  event: [
    "你写的是「快讯深读」：第一句说清这事是什么（谁、干了什么、多少钱/多少量），",
    "第二句说它可能牵动哪类票（只提板块方向，不点个股买卖），",
    "最后一句这件事接下来看什么（比如等官宣、等数据、等落地）。",
    "如果快讯本身信息量少，就少写，别硬凑三段。",
  ].join("\n"),
  recap: [
    "你写的是「每日复盘」：三句话收场——第一句指数今天什么成色（带具体涨跌幅），",
    "第二句涨跌家数和涨跌停（赚钱效应还是亏钱效应），",
    "第三句你自己的感受（比如“看着红其实难做”这种，要有态度）。",
    "别写“震荡整理”这种废话，涨就是涨、跌就是跌。",
  ].join("\n"),
  sentiment: [
    "你写的是「连板梯队」：开头报最高几板和各有几只，",
    "中间说梯队形状（是厚是薄、断没断档），",
    "最后一句这情绪像什么（用比喻，比如“独苗”“梯田”）。",
    "连板是情绪数据不是买入信号，语气可以兴奋但不煽动。",
  ].join("\n"),
};

const PLATFORM_HINT: Record<StudioPlatform, string> = {
  douyin: "抖音竖版：标题用情绪词+数字抓眼球；正文像朋友聊天、短句有节奏、可带一句调侃；别用书面语；标签 5 个。",
  wechat: "公众号：标题克制但带悬念和数字；正文先给结论再摆数据，像财经老手跟读者聊；不堆 emoji；标签 3 个。",
};

// ── 文案上下文（按体裁拉数据） ──────────────────────────────────────

async function gatherContext(genre: StudioGenre, topic: StudioTopic, opts: BuildOpts): Promise<string> {
  try {
    switch (topic) {
      case "stockVersus":
      case "sectorVersus": {
        const flow = await loadFlow();
        const label = topic === "sectorVersus" ? "板块" : "个股";
        const fmt = (rows: typeof flow.stocksIn) =>
          rows.slice(0, opts.topN).map((r) => `${r.name} ${studioAbsWan(r.inflow)}`).join("，");
        const poolIn = topic === "sectorVersus" ? flow.sectorsIn : flow.stocksIn;
        const poolOut = topic === "sectorVersus" ? flow.sectorsOut : flow.stocksOut;
        return `${label}主力净流入前 ${opts.topN}：${fmt(poolIn)}；净流出前 ${opts.topN}：${fmt(poolOut)}`;
      }
      case "seats": {
        const book = await loadHotMoney();
        return "游资席位净买前 " + opts.topN + "：" + book.seats.slice(0, opts.topN).map((s) => `${s.name} ${studioAbsWan(s.netWan)}${s.stocks.length ? `（买了 ${s.stocks.slice(0, 3).map((st) => st.name).join("、")}）` : ""}`).join("，");
      }
      case "news": {
        const news = await loadNews();
        const picked = news[opts.newsIndex ?? 0];
        if (!picked) return "（今天暂无快讯）";
        return `快讯标题：${picked.title}\n时间：${picked.time}\n摘要：${picked.summary || "（无摘要，只有标题）"}${picked.stocks.length ? `\n涉及个股：${picked.stocks.slice(0, 6).map((s) => `${s.name}${s.chg != null ? `(${studioPct(s.chg)})` : ""}`).join("、")}` : ""}`;
      }
      case "daily": {
        const lines: string[] = [];
        try {
          const idx = await loadIndices();
          if (idx.length) lines.push("指数：" + idx.map((i) => `${i.name} ${i.price.toFixed(2)}（${studioPct(i.pct)}）`).join("，"));
        } catch {
          /* 忽略 */
        }
        try {
          const u = await loadUniverse(false);
          const b = marketBreadth(u.quotes);
          lines.push(`涨跌：上涨 ${b.up} / 下跌 ${b.down} / 平盘 ${b.flat}，涨停 ${b.limitUp} 跌停 ${b.limitDown}`);
        } catch {
          /* 忽略 */
        }
        return lines.join("\n") || "（暂无数据）";
      }
      case "ladder": {
        // 连板梯队复用 /signals 的现成数据（getSignals 内部已拉涨停池并汇总），
        // 不自己再拉一遍——东财限速，重复拉纯浪费。
        const { getSignals } = await import("./limit-up.functions");
        const s = (await getSignals()).summary;
        if (!s || s.ladder.length === 0) return "（今日无连板）";
        return "连板梯队：" + s.ladder.map((r) => `${r.streak} 板 ${r.count} 只`).join("，") + `；炸板率 ${s.breakRate ?? "?"}%`;
      }
    }
  } catch {
    return "（暂无数据）";
  }
}

/** 生成一段图文文案。失败抛错。 */
export async function generateCaption(
  genre: StudioGenre,
  topic: StudioTopic,
  platform: StudioPlatform,
  extra?: string,
): Promise<string> {
  const opts: BuildOpts = { topN: 10 };
  const ctx = await gatherContext(genre, topic, opts);
  const voice = [
    "你是一个做了三年财经自媒体的真人博主，风格像跟朋友聊盘面，有情绪、有观点、口语化，不是新闻播报、不是研报。",
    "",
    "【这篇的体裁】" + GENRE_VOICE[genre],
    "",
    "【平台】" + PLATFORM_HINT[platform],
    "",
    "【今日数据】",
    ctx,
    ...(extra && extra.trim() ? ["", "【博主自己补充的观点】（自然融进文案，别原话照搬，别让它盖过数据）：" + extra.trim()] : []),
    "",
    "输出格式严格如下（三行，别加多余标题）：",
    "【标题】一句抓眼球的话，带具体数字或情绪（10~18 字，能当图片大标题）",
    "【正文】按上面的体裁写法写，2-4 句",
    "【标签】带 # 的话题",
    "",
    "【铁律】",
    RULES,
  ].join("\n");
  return callDSH(voice, { system: "你是财经自媒体博主，写口语化、有态度的短内容。严格按用户给的结构和铁律输出。" });
}

/** 从文案里抽出「标题」那一行（当图片大标题用）。抽不到就用默认标题。 */
export function titleFromCaption(caption: string, fallback: string): string {
  const m = caption.match(/【标题】\s*(.+)/);
  const title = m?.[1]?.trim();
  return title && title.length <= 20 ? title : fallback;
}
