/**
 * 这个文件是干什么的：
 * 自媒体「图文」的内容层：把项目数据变成可发的「图（spec）+ 文（文案）」。
 * 不绑定单一内容：支持复盘 / 个股流入流出排名 / 板块 / 游资 / 热点 等多种内容类型。
 *
 * 你需要知道的：
 * - buildStudioItems 是纯函数，把数据整理成海报条目（给 studio-poster 画图）。
 * - generateCaption 走 DSH（DeepSeek）生成文案，只写数据里有的、不荐股。
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
import { STUDIO_INK, studioAbsWan, studioPct, studioTone, type StudioItem } from "./studio-poster.ts";

export type StudioKind = "daily" | "stockIn" | "stockOut" | "sector" | "hotMoney" | "news";
export type StudioPlatform = "douyin" | "wechat";

export type StudioData = {
  indices: IndexQuote[];
  breadth: Breadth;
  flow: FlowBook | null;
  hotMoney: HotBook | null;
  news: NewsItem[];
};

export const KIND_LABEL: Record<StudioKind, string> = {
  daily: "每日复盘",
  stockIn: "个股流入排名",
  stockOut: "个股流出排名",
  sector: "板块轮动",
  hotMoney: "游资动向",
  news: "热点事件",
};

const KIND_TITLE: Record<StudioKind, string> = {
  daily: "今日 A 股",
  stockIn: "主力净流入 TOP",
  stockOut: "主力净流出 TOP",
  sector: "板块净流入 TOP",
  hotMoney: "游资动向",
  news: "今日热点",
};

/** 文案系统提示：像真人博主、口语、有情绪、有观点，去 AI 套话。 */
const CAPTION_SYSTEM = [
  "你是一个做了三年财经自媒体的真人博主，风格像跟朋友聊盘面，有情绪、有观点、口语化，不是新闻播报、不是研报。",
  "输出格式严格如下（三行，别加多余标题）：",
  "【标题】一句抓眼球的话，带具体数字或情绪（10~18 字，能当图片大标题）",
  "【正文】2-4 句口语，先甩结论再补数据，有你的判断和态度",
  "【标签】3-5 个带 # 的话题",
  "铁律：",
  "1) 只写数据里有的，没给的不编；",
  "2) 不给买卖建议（不出现买入/卖出/加仓/抄底）；",
  "3) 禁止这些 AI 套话：今日复盘、综上所述、值得关注、总的来说、值得注意的是、让我们一起、不难发现、可以看出；",
  "4) 禁止整整齐齐的对仗排比，长短句要错开，像人说话；",
  "5) 数字用具体数，涨跌用百分比、金额用亿/万。",
].join("\n");

const PLATFORM_HINT: Record<StudioPlatform, string> = {
  douyin: "抖音竖版：标题用情绪词+数字抓眼球；正文像朋友聊天、短句有节奏、可带一句调侃；别用书面语；标签 5 个。",
  wechat: "公众号：标题克制但带悬念和数字；正文先给结论再摆数据，像财经老手跟读者聊；不堆 emoji；标签 3 个。",
};

/** 把数据整理成海报条目（排名列表）。 */
export function buildStudioItems(kind: StudioKind, data: StudioData): StudioItem[] {
  const flow = data.flow;
  switch (kind) {
    case "daily":
      return data.indices.slice(0, 6).map((i) => ({ name: i.name, value: studioPct(i.pct), color: studioTone(i.pct) }));
    case "stockIn":
      return (flow?.stocksIn ?? []).slice(0, 10).map((r) => ({ name: r.name, value: `${r.inflow > 0 ? "+" : ""}${studioAbsWan(r.inflow)}`, color: studioTone(r.inflow) }));
    case "stockOut":
      return (flow?.stocksOut ?? []).slice(0, 10).map((r) => ({ name: r.name, value: `${r.inflow > 0 ? "+" : ""}${studioAbsWan(r.inflow)}`, color: studioTone(r.inflow) }));
    case "sector":
      return (flow?.sectorsIn ?? []).slice(0, 10).map((r) => ({ name: r.name, value: `${r.inflow > 0 ? "+" : ""}${studioAbsWan(r.inflow)}`, color: studioTone(r.inflow) }));
    case "hotMoney":
      return (data.hotMoney?.seats ?? []).slice(0, 10).map((s) => ({
        name: s.name,
        value: `${s.netWan > 0 ? "+" : ""}${studioAbsWan(s.netWan)}`,
        color: studioTone(s.netWan),
        note: s.stocks.slice(0, 3).map((st) => st.name).join(" · "),
      }));
    case "news":
      return (data.news ?? []).slice(0, 8).map((n) => ({ name: n.title, value: n.time, color: STUDIO_INK }));
  }
}

/** 海报默认标题（AI 标题生成失败时的兜底）。 */
export function defaultTitle(kind: StudioKind): string {
  return KIND_TITLE[kind];
}

// ── 文案上下文（各内容类型）──

async function dailyContext(): Promise<string> {
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
    lines.push(`涨跌：上涨 ${b.up} / 下跌 ${b.down} / 平盘 ${b.flat}（共 ${b.up + b.down + b.flat} 只），涨停 ${b.limitUp} 跌停 ${b.limitDown}`);
  } catch {
    /* 忽略 */
  }
  try {
    const flow = await loadFlow();
    lines.push("主力净流入前 5 板块：" + flow.sectorsIn.slice(0, 5).map((r) => `${r.name} ${studioAbsWan(r.inflow)}`).join("，"));
  } catch {
    /* 忽略 */
  }
  return lines.join("\n") || "（暂无数据）";
}

async function flowContext(kind: "stockIn" | "stockOut" | "sector"): Promise<string> {
  try {
    const flow = await loadFlow();
    const pick = kind === "stockIn" ? flow.stocksIn : kind === "stockOut" ? flow.stocksOut : flow.sectorsIn;
    const label = kind === "sector" ? "板块" : "个股";
    return `${label}主力净${kind === "stockOut" ? "流" : "流入"}前 10：` + pick.slice(0, 10).map((r) => `${r.name} ${studioAbsWan(r.inflow)}`).join("，");
  } catch {
    return "（暂无数据）";
  }
}

async function hotMoneyContext(): Promise<string> {
  try {
    const book = await loadHotMoney();
    return "游资席位净买前 10：" + book.seats.slice(0, 10).map((s) => `${s.name} ${studioAbsWan(s.netWan)}${s.stocks.length ? `（${s.stocks.slice(0, 3).map((st) => st.name).join("、")}）` : ""}`).join("，");
  } catch {
    return "（暂无数据）";
  }
}

async function newsContext(): Promise<string> {
  try {
    const news = await loadNews();
    return "今日热点快讯（前 10 条）：" + news.slice(0, 10).map((n) => n.title).join("；");
  } catch {
    return "（暂无数据）";
  }
}

/** 生成一段图文文案。返回 AI 写的「标题/正文/标签」三行文本。失败抛错。 */
export async function generateCaption(kind: StudioKind, platform: StudioPlatform): Promise<string> {
  const ctx =
    kind === "daily"
      ? await dailyContext()
      : kind === "stockIn" || kind === "stockOut" || kind === "sector"
        ? await flowContext(kind)
        : kind === "hotMoney"
          ? await hotMoneyContext()
          : await newsContext();
  const prompt = `【内容类型】${KIND_LABEL[kind]}\n【平台】${PLATFORM_HINT[platform]}\n【今日数据】\n${ctx}\n\n请按格式生成文案。`;
  return callDSH(prompt, { system: CAPTION_SYSTEM });
}

/** 从文案里抽出「标题」那一行（当图片大标题用）。抽不到就用默认标题。 */
export function titleFromCaption(caption: string, fallback: string): string {
  const m = caption.match(/【标题】\s*(.+)/);
  const title = m?.[1]?.trim();
  return title && title.length <= 20 ? title : fallback;
}
