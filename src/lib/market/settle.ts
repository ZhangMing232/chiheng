/**
 * 这个文件是干什么的：
 * 单笔持仓的结算判定（E3 抽取，原来内联在 record-journal.ts 的结算段）。
 *
 * 抽它的理由：结算是**会写进账本**的动作，而它原来内联在 751 行的记账进程里
 * （scripts/ 不做类型检查、没有单测）。判定逻辑里还埋着一个踩过的坑——
 * 「算不出来」有两种，分开说才不会天天误报（原文注释）：
 *   1. 买入日不在这 120 根 K 线里（停牌很久/持仓比 K 线窗口还早）→ 真卡住，
 *      永远挂着、占名额、不进胜率，页面上看不出来
 *   2. 已过持有天数仍算不出 → 也算卡住，但要说出已过了几天
 *   3. 还没到卖出日 → **正常得很**（09-30 建的仓今天才 3 个交易日），
 *      早先一律报「会一直挂着」，结果每次拿几十笔正常持仓刷一条假警报
 *
 * 你需要知道的：
 * - 只做判定，不写账本——账本写入留在调用方（record-journal.ts）
 * - 成交价一律走 exitFill（journal-book.ts），这里不自己算
 * - 没带止损止盈的老账本用 planExit 现推（和开仓同一套口径），不在这儿另写百分比
 */

import { exitFill } from "@/lib/market/journal-book";
import { boardLimit, HOLD_SESSIONS, planExit } from "@/lib/market/model";
import { DEFAULT_RULES, type EarlyRules } from "@/lib/market/rules";
import type { Bar } from "@/lib/market/types";

export type SettleInput = {
  id: string;
  name: string;
  /** 买入日（YYYY-MM-DD） */
  dayDate: string;
  entry: number;
  stop: number | null;
  target: number | null;
  /** 持有交易日；没传用 HOLD_SESSIONS（和记账进程一致） */
  hold?: number | null;
  /** 最近 K 线（按日期升序，日线） */
  bars: readonly Bar[];
  /** 推算止损止盈用的规则；不传用默认规则 */
  rules?: EarlyRules;
};

export type SettleVerdict =
  | { kind: "filled"; price: number; date: string; reason: "target" | "stop" | "time" }
  /** 还没到卖出日——正常状态，不要报 */
  | { kind: "waiting"; passed: number }
  /** 真卡住：买入日不在 K 线窗口里 */
  | { kind: "stuck-no-buy-day"; reason: string }
  /** 真卡住：已过持有天数仍算不出 */
  | { kind: "stuck-overdue"; reason: string };

/**
 * 判定一笔未平仓持仓现在该怎么结算。
 *
 * 顺序照原版：先试 exitFill（成交了就成交）→ 没成交再分「K 线里没有买入日」
 * 和「已过/未过持有天数」两种。
 */
export function settleOne(input: SettleInput): SettleVerdict {
  const hold = input.hold ?? HOLD_SESSIONS;
  const plan =
    input.stop != null && input.target != null
      ? { stop: input.stop, target: input.target }
      : // 没带止损目标价（早期账本）→ 用规则现推，和开仓时同一套口径
        planExit(input.entry, null, input.rules ?? DEFAULT_RULES);

  const filled = exitFill(input.bars as Bar[], input.dayDate, input.entry, plan.stop, plan.target, boardLimit(input.id, input.name), hold);
  if (filled) return { kind: "filled", price: filled.price, date: filled.date, reason: filled.reason };

  // 没成交：分两种「算不出来」+ 一种「还没到时候」
  const hasBuyDay = input.bars.some((bar) => bar.date === input.dayDate);
  if (!hasBuyDay) {
    return {
      kind: "stuck-no-buy-day",
      reason: `${input.name} ${input.dayDate}（K 线里没有买入日这根，最早 ${input.bars[0]?.date ?? "无"}）`,
    };
  }
  const passed = input.bars.filter((bar) => bar.date > input.dayDate).length;
  if (passed < hold) return { kind: "waiting", passed };
  return {
    kind: "stuck-overdue",
    reason: `${input.name} ${input.dayDate}（已过 ${passed} 个交易日仍算不出卖出价）`,
  };
}

/** 这笔要不要当作「卡住」报出来。waiting 是正常状态，不算。 */
export function isStuck(verdict: SettleVerdict): boolean {
  return verdict.kind === "stuck-no-buy-day" || verdict.kind === "stuck-overdue";
}
