/**
 * 这个文件是干什么的：
 * 「大管家」—— 常驻 AI 助手。它每次回答前先读一遍项目当前状态（指数 / 涨跌分布 /
 * 账本 / 挑战者），把状态作为上下文喂给 DeepSeek HARNESS（DSH），再回答用户。
 *
 * 你需要知道的：
 * - 只读、只答，不写账本、不改判决、不下单。上下文里没有的信息就如实说「不知道」。
 * - 走 DSH 桥接（callDSH）；DSH 挂了会抛错，由上层 serverFn 接住返回「暂时不可用」。
 * - 数据读取都是现成的 load/read 函数，这里只是「聚合成一屏文字」。
 */

import { loadIndices, loadUniverse } from "./quotes.functions.ts";
import { OWNER_ID, readUserBook } from "./book-file.ts";
import { readChallengers } from "./challenger.ts";
import { callDSH } from "./chiheng-dsh-client.ts";

/** 大管家的系统提示：中文、简洁、只基于给定状态、不编数、不给投资建议。 */
const BUTLER_SYSTEM = [
  "你是赤轨的「大管家」，一个 A 股量化研究工具里的常驻 AI 助手。",
  "回答用户关于项目状态、行情、持仓、策略、因子、回测、自选、新闻等问题。",
  "规则：",
  "1) 用中文，简洁准确，优先直接给结论。",
  "2) 只基于下方【项目状态】里给出的数据回答；没有的信息如实说「不知道 / 没取到」，不要编数字。",
  "3) 不给投资买卖建议（这是红线），只描述数据和现状。",
].join("\n");

type DayShape = { trades?: { exit?: number | null }[] };

/** 把项目当前状态聚合成一段文字。读不到的部分就跳过，不让整段崩。 */
export async function buildButlerContext(): Promise<string> {
  const lines: string[] = [];
  try {
    const idx = await loadIndices();
    if (idx.length) {
      lines.push(
        "【指数】" +
          idx.map((i) => `${i.name} ${i.price.toFixed(2)}（${i.pct >= 0 ? "+" : ""}${i.pct.toFixed(2)}%）`).join("，"),
      );
    }
  } catch {
    /* 指数读不到就跳过 */
  }
  try {
    const u = await loadUniverse(false);
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const q of u.quotes) {
      const c = q.chg ?? 0;
      if (c > 0) up += 1;
      else if (c < 0) down += 1;
      else flat += 1;
    }
    lines.push(`【涨跌分布】上涨 ${up} / 下跌 ${down} / 平盘 ${flat}（共 ${u.quotes.length} 只，来源 ${u.source ?? "未知"}）`);
  } catch {
    /* 快照读不到就跳过 */
  }
  try {
    const book = await readUserBook<DayShape>(OWNER_ID);
    let trades = 0;
    let open = 0;
    for (const d of book.days ?? []) {
      for (const t of d.trades ?? []) {
        trades += 1;
        if (t.exit == null) open += 1;
      }
    }
    lines.push(`【账本】${book.days?.length ?? 0} 个交易日，共 ${trades} 笔，未平仓 ${open} 笔`);
  } catch {
    /* 账本读不到就跳过 */
  }
  try {
    const chal = await readChallengers();
    const running = chal.list.filter((c) => c.status === "running");
    if (running.length) {
      lines.push("【挑战者（运行中）】" + running.map((c) => `${c.name}（${c.style}，${c.since} 起）`).join("，"));
    }
  } catch {
    /* 挑战者读不到就跳过 */
  }
  return lines.join("\n") || "（暂无项目状态数据）";
}

/** 回答用户一个问题。先读状态当上下文，再走 DSH。失败抛错（上层接住）。 */
export async function askButler(question: string): Promise<string> {
  const ctx = await buildButlerContext();
  const prompt = `【项目状态】\n${ctx}\n\n【用户问题】\n${question}`;
  return callDSH(prompt, { system: BUTLER_SYSTEM });
}
