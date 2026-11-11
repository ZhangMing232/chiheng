/**
 * 生成「题材前瞻简报」数据：把当日的题材催化 × 概念成分股 × 今日涨停 × 行情，
 * 折成一份「事实 → 题材 → 个股 + 分数 + 论据」的结构化文件。
 *
 * 为什么要有这个脚本：/brief 页面只做展示，不在请求里算。这里的每一个分数都能
 * 被人拿着页面上的四个论据手工复算出来——这是硬要求，不许出现黑箱加权。
 *
 * 评分口径（写死在代码里，也印在页面上）：
 *   涨停基座 0–50  今日涨停 40；连板每多一板 +10，封顶 +20
 *   封单强度 0–20  封单额 / 1 亿 × 20，封顶 20
 *   位置    0–20  同题材内 5 日涨幅的百分位越低分越高（不追高）
 *   题材纯正 0–10  第三方原始记录里的 primary_concept 与本题材同名 +10
 *
 * 已知边界：
 * - 成分股来自 data/backtest/concepts.json（东财 L3 板块），一个票可能在多个题材里，不去重。
 * - 催化原文来自 data/history/limit-up-reasons（第三方整理），本脚本**不改写、不摘要**。
 * - 没有催化的题材照样列出，但标「暂无催化」——不编一条理由。
 *
 * 用法：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/brief-build.ts
 * 输出：data/history/brief/YYYY-MM-DD.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

type Quote = { id: string; code: string; name: string; chg: number; cap: number; floatCap: number; d5: number; d20: number; turnover: number; st: boolean };
type PoolRow = { id: string; code: string; name: string; streak: number; sealFund: number; breaks: number };
type ReasonRow = { code: string; name: string; primary_concept: string; theme: string; reason: string };
type SectorRow = { title: string; reason: string; date: string };

const TOP_THEMES = 12;
const MIN_LIMIT_UP = 5;
/** 超额集中度下限：该题材涨停率至少是全市场的 1.8 倍，才算「今天真的在炒」。 */
const MIN_LIFT = 1.8;

/**
 * 属性标签黑名单。
 *
 * 东财 L3 板块里混着大量**不是题材的标签**：融资融券、深股通、昨日涨停、
 * 小盘股、连续亏损、标准普尔……它们成分股动辄上千只，按绝对涨停家数排
 * 一定排在最前面（实测 2026-11-11 榜首是「融资融券 34 家涨停」）。
 * 这些标签对「下一个热门」没有任何信息量，必须先剔掉，剩下的才是题材。
 *
 * 黑名单是无奈之举（没有权威的题材/标签分类字段可依），所以还要配合 lift
 * 兜底：即使漏掉一个属性标签，它的 lift 也高不到哪去。
 */
const ATTRIBUTE_LABEL = new RegExp(
  [
    "昨日", "今日", "最近", "近期", "新高", "新低", "多板", "高换手", "高振幅", "振幅",
    "涨停", "连板", "炸板", "触板",
    "融资融券", "深股通", "沪股通", "港股通", "MSCI", "富时", "标普", "标准普尔", "转债",
    "基金", "重仓", "增仓", "减仓", "证金", "汇金", "社保", "QFII", "险资", "北向",
    "预盈", "预增", "预减", "业绩", "扭亏", "亏损", "破净", "破增发", "解禁", "质押",
    "回购", "员工持股", "股权激励", "举牌", "高送转", "摘帽", "退市", "ST",
    "次新", "低价", "百元", "小盘", "大盘", "中盘", "成长", "价值", "风格",
    "分红", "股息", "国改", "央企", "国企", "专精特新", "科创板", "创业板",
    "热股", "题材股", "概念股", "同花顺", "东方财富",
    // 2026-11-11 补：东财 L3 里还混着「2026中报预告」这种定期报告标签，
    // 上一版黑名单只写了「业绩」没写「中报/预告」，它靠 9 家涨停混进了题材榜。
    "中报", "年报", "一季报", "三季报", "季报", "预告", "预披露", "快报",
    "沪深300", "上证50", "中证", "深证", "创业板指", "AH股", "GDR", "B股",
  ].join("|"),
);

/** 题材内 5 日涨幅百分位：严格小于 + 0.5×相等，再除以样本数。 */
function pctRank(values: number[], v: number): number {
  if (values.length === 0) return 0.5;
  let less = 0;
  let eq = 0;
  for (const x of values) {
    if (x < v) less += 1;
    else if (x === v) eq += 1;
  }
  return (less + 0.5 * eq) / values.length;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const uni = await readJson<{ payload?: { quotes?: Quote[] } }>("data/universe-cache.json");
  const concepts = await readJson<{ boards?: { name: string; code: string; members: string[] }[] }>("data/backtest/concepts.json");
  const snap = await readJson<{ date: string; sealed: boolean; capturedAt: number; limitUp: PoolRow[]; broken: PoolRow[] }>(
    "data/signals/limit-pools-today.json",
  );
  if (!snap) throw new Error("limit-pools-today.json 读不到，先跑 capture-market-snapshot");
  const reasons = await readJson<{ date: string; reasons?: Record<string, ReasonRow>; sectors?: Record<string, SectorRow[]> }>(
    `data/history/limit-up-reasons/${snap.date}.json`,
  );

  const quotes = uni?.payload?.quotes ?? [];
  if (quotes.length === 0) throw new Error("universe-cache 读不到，无法算简报");

  const qById = new Map(quotes.map((q) => [q.id, q]));
  const inPool = new Map<string, PoolRow>();
  for (const r of snap.limitUp) inPool.set(r.id, r);

  const totalLimitUp = snap.limitUp.length;
  /** 全市场涨停率：lift 的分母。 */
  const baseRate = totalLimitUp / Math.max(1, quotes.length);
  const sectorKeys = Object.keys(reasons?.sectors ?? {});
  /** 催化名与板块名不同源（"光伏" vs "光伏概念"），双向包含算命中，取第一个。 */
  const catalystOf = (name: string) => {
    const key = sectorKeys.find((k) => k === name) ?? sectorKeys.find((k) => k.includes(name) || name.includes(k));
    if (!key) return null;
    const row = reasons?.sectors?.[key]?.[0];
    return row ? { title: row.title, date: row.date, reason: row.reason, key } : null;
  };
  const themes: {
    name: string;
    code: string;
    members: number;
    limitUp: number;
    lift: number;
    maxStreak: number;
    leader: string;
    catalyst: { title: string; date: string; reason: string } | null;
    stocks: {
      id: string;
      code: string;
      name: string;
      streak: number;
      sealFund: number;
      score: number;
      scoreParts: { label: string; value: string }[];
    }[];
    note: string;
  }[] = [];

  for (const board of concepts?.boards ?? []) {
    if (ATTRIBUTE_LABEL.test(board.name)) continue;
    const members = board.members.map((id) => qById.get(id)).filter((q): q is Quote => Boolean(q));
    if (members.length === 0) continue;
    const upRows = board.members.map((id) => inPool.get(id)).filter((r): r is PoolRow => Boolean(r));
    if (upRows.length < MIN_LIMIT_UP) continue;
    // 超额集中度：题材涨停率 ÷ 全市场涨停率。用它而不是绝对家数，
    // 是因为大成分股板块（新能源车 720 只、机器人 824 只）天然涨停多，
    // 按家数排会把「成分股多」误当成「今天在炒」。
    const lift = baseRate > 0 ? upRows.length / members.length / baseRate : 0;
    const cat = catalystOf(board.name);
    // 两条路入选，任一即可：
    //   ① 涨停密度显著高于全市场（lift ≥ 1.8）——今天真在炒；
    //   ② 今天有催化原文——哪怕是宽口径大题材（机器人 800 多只成分股，lift 天然低）。
    // 只有家数够（≥5）才进，避免 3 只票的小题材靠 lift 冒到第一。
    if (lift < MIN_LIFT && !cat) continue;

    const d5s = members.map((m) => m.d5 ?? 0);
    const maxStreak = Math.max(0, ...upRows.map((r) => r.streak ?? 1));
    const leader = [...upRows].sort((a, b) => (b.streak ?? 1) - (a.streak ?? 1) || (b.sealFund ?? 0) - (a.sealFund ?? 0))[0];

    const stocks = upRows
      .map((r) => {
        const q = qById.get(r.id);
        const d5 = q?.d5 ?? 0;
        const rank = pctRank(d5s, d5);
        const streak = r.streak ?? 1;
        const sealWan = (r.sealFund ?? 0) / 1e4;
        const base = 40 + Math.min(20, (streak - 1) * 10);
        const seal = Math.min(20, ((r.sealFund ?? 0) / 1e8) * 20);
        const pos = (1 - rank) * 20;
        const info = reasons?.reasons?.[r.code ?? ""];
        const purity = info && info.primary_concept === board.name ? 10 : 0;
        const score = Math.round((base + seal + pos + purity) * 10) / 10;
        return {
          id: r.id,
          code: r.code ?? "",
          name: r.name,
          streak,
          sealFund: r.sealFund ?? 0,
          score,
          scoreParts: [
            { label: "涨停基座", value: `${streak}板 → ${base}` },
            { label: "封单强度", value: `${sealWan.toFixed(0)}万 → ${seal.toFixed(1)}` },
            { label: "位置", value: `5日${d5 >= 0 ? "+" : ""}${d5.toFixed(1)}%（题材内分位 ${(rank * 100).toFixed(0)}%）→ ${pos.toFixed(1)}` },
            { label: "题材纯正", value: info ? `原记录题材=${info.primary_concept} → ${purity}` : `无原记录 → 0` },
          ],
        };
      })
      .sort((a, b) => b.score - a.score);

    themes.push({
      name: board.name,
      code: board.code,
      members: members.length,
      limitUp: upRows.length,
      lift: Math.round(lift * 10) / 10,
      maxStreak,
      leader: leader?.name ?? "",
      catalyst: cat ? { title: cat.title, date: cat.date, reason: cat.reason } : null,
      stocks: stocks.slice(0, 6),
      note:
        `今日涨停 ${upRows.length} 家（全市场 ${totalLimitUp} 家的 ${((upRows.length / Math.max(1, totalLimitUp)) * 100).toFixed(0)}%），` +
        `最高 ${maxStreak} 板，龙头 ${leader?.name ?? "—"}；成分股 ${members.length} 只，` +
        `涨停密度 ${(lift * 100).toFixed(0)}% 是全市场 ${(baseRate * 100).toFixed(1)}% 的 ${lift.toFixed(1)} 倍。`,
    });
  }

  themes.sort((a, b) => b.limitUp - a.limitUp || b.lift - a.lift);

  const out = {
    date: snap.date,
    generatedAt: new Date().toISOString(),
    sealed: snap.sealed,
    capturedAt: snap.capturedAt,
    reasonDate: reasons?.date ?? "",
    poolDate: snap.date,
    scoring: {
      version: 1,
      terms: [
        "涨停基座 0–50（涨停 40，每多一板 +10，封顶 +20）",
        "封单强度 0–20（封单额÷1亿×20，封顶 20）",
        "位置 0–20（同题材内 5 日涨幅分位越低越高，不追高）",
        "题材纯正 0–10（第三方原记录的 primary_concept 与本题材同名）",
      ],
      note: "分数只描述「今日资金在这只票上的相对强度」，不预测次日，也不是买入信号。",
    },
    totalLimitUp,
    themes: themes.slice(0, TOP_THEMES),
    dropped: { themesWithFewerThan: MIN_LIMIT_UP },
  };

  await mkdir("data/history/brief", { recursive: true });
  await writeFile(`data/history/brief/${snap.date}.json`, JSON.stringify(out, null, 1), "utf8");
  console.log(`[brief] ${snap.date}：入选 ${out.themes.length} 个题材（阈值 ≥${MIN_LIMIT_UP} 家涨停）`);
  for (const t of out.themes.slice(0, 5)) {
    console.log(`  ${t.name}  涨停${t.limitUp} 最高${t.maxStreak}板  催化${t.catalyst ? "有" : "无"}  首推 ${t.stocks[0]?.name ?? "—"} ${t.stocks[0]?.score ?? ""}`);
  }
}

await main();
