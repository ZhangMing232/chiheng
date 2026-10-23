/**
 * 这个文件是干什么的：
 * 自媒体「图文」的文案生成。把项目数据（指数/涨跌/资金/快讯）聚合成上下文，
 * 交给 DeepSeek HARNESS（callDSH）写出一段可直接发布的「标题 + 正文 + 标签」。
 *
 * 你需要知道的：
 * - 只生成文案，不生成图片（图片走 poster 那一套）；不荐股、不编数。
 * - 平台两种：douyin（抖音，短/口语/emoji/标签多）、wechat（公众号，正式/数据详实）。
 * - 文案是 AI 初稿，用户拿到后自己改再发。
 */

import { loadIndices, loadUniverse } from "./quotes.functions.ts";
import { loadFlow } from "./flow.ts";
import { loadNews } from "./news.ts";
import { marketBreadth } from "./slim-universe.ts";
import { callDSH } from "./chiheng-dsh-client.ts";

export type StudioKind = "daily" | "flow";
export type StudioPlatform = "douyin" | "wechat";

/** 文案系统提示：像真人博主、口语、有情绪、有观点，去 AI 套话。 */
const CAPTION_SYSTEM = [
  "你是一个做了三年财经自媒体的真人博主，风格像跟朋友聊盘面，有情绪、有观点、口语化，不是新闻播报、不是研报。",
  "输出格式严格如下（三行，别加多余标题）：",
  "【标题】一句抓眼球的话，带具体数字或情绪",
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
  douyin:
    "抖音竖版：标题用情绪词+数字抓眼球（例「4700家下跌，主力跑了」「今天这盘面有点东西」）；正文像朋友聊天、短句有节奏、可以带一句调侃或反问；别用书面语；标签 5 个。",
  wechat:
    "公众号：标题克制但带悬念和数字（例「今天这 3 个板块，主力在偷偷加仓」）；正文先给结论再摆数据，像财经老手跟读者聊，语气稳但不端着；不堆 emoji；标签 3 个。",
};

/** 每日复盘上下文：指数 + 涨跌分布 + 主力/北向 + 最新快讯标题。 */
async function dailyContext(): Promise<string> {
  const lines: string[] = [];
  try {
    const idx = await loadIndices();
    if (idx.length) {
      lines.push("指数：" + idx.map((i) => `${i.name} ${i.price.toFixed(2)}（${i.pct >= 0 ? "+" : ""}${i.pct.toFixed(2)}%）`).join("，"));
    }
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
    const north = flow.north[0];
    const in3 = flow.sectorsIn.slice(0, 3).map((r) => `${r.name} ${(r.inflow / 1e4).toFixed(1)} 亿`).join("、");
    lines.push(`资金：主力净流入前 3 板块 ${in3}${north ? `；北向成交额 ${(north.amount / 1e4).toFixed(1)} 亿` : ""}`);
  } catch {
    /* 忽略 */
  }
  try {
    const news = await loadNews();
    if (news.length) lines.push("快讯（前 5 条标题）：" + news.slice(0, 5).map((n) => n.title).join("；"));
  } catch {
    /* 忽略 */
  }
  return lines.join("\n") || "（暂无数据）";
}

/** 资金异动上下文：主力净流入/流出前几的板块和个股。 */
async function flowContext(): Promise<string> {
  const lines: string[] = [];
  try {
    const flow = await loadFlow();
    lines.push("板块主力净流入前 5：" + flow.sectorsIn.slice(0, 5).map((r) => `${r.name} ${(r.inflow / 1e4).toFixed(1)} 亿${r.chg == null ? "" : `（${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}%）`}`).join("，"));
    lines.push("板块主力净流出前 5：" + flow.sectorsOut.slice(0, 5).map((r) => `${r.name} ${(r.inflow / 1e4).toFixed(1)} 亿`).join("，"));
    lines.push("个股主力净流入前 5：" + flow.stocksIn.slice(0, 5).map((r) => `${r.name} ${(r.inflow / 1e4).toFixed(1)} 亿`).join("，"));
    lines.push("个股主力净流出前 5：" + flow.stocksOut.slice(0, 5).map((r) => `${r.name} ${(r.inflow / 1e4).toFixed(1)} 亿`).join("，"));
  } catch {
    /* 忽略 */
  }
  return lines.join("\n") || "（暂无数据）";
}

/** 生成一段图文文案。返回 AI 写的「标题/正文/标签」三行文本。失败抛错。 */
export async function generateCaption(kind: StudioKind, platform: StudioPlatform): Promise<string> {
  const ctx = kind === "daily" ? await dailyContext() : await flowContext();
  const kindLabel = kind === "daily" ? "每日复盘" : "资金异动";
  const prompt = `【内容类型】${kindLabel}\n【平台】${PLATFORM_HINT[platform]}\n【今日数据】\n${ctx}\n\n请按格式生成文案。`;
  return callDSH(prompt, { system: CAPTION_SYSTEM });
}
