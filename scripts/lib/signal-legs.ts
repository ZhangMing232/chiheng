/**
 * 两条腿的「什么时候走」——单一出处，别在推送文案里再硬编码一遍。
 *
 * 短线 5 个交易日：回测登记版 evt-themeLaggard 的 hold（scripts/backtest.ts:997）。
 * 中长线 8 个交易日：早盘推送原本写在纪律行里的口径。
 *
 * 口径（用户 2026-11-10 点名要「什么时候走」）：买入日算第 1 日，
 * 第 N 个交易日收盘走；中途打到止损或目标，先到先走。
 * T+1 铁律不变——买入当天不卖。
 *
 * 这里**不写具体日历日期**：交易日受节假日影响，用周末近似算出来的日期
 * 会错，错日期比不给日期更坏。给「第 N 日 + 规则」，人自己能对上日历。
 */
export type Leg = "short" | "long";

export const LEG_HOLD_DAYS: Record<Leg, number> = { short: 5, long: 8 };

/** 旧候选文件没有 leg 字段时按策略名回退（热点·题材补涨 = 短线）。 */
export function legOf(s: { leg?: Leg; strategy?: string }): Leg {
  if (s.leg === "short" || s.leg === "long") return s.leg;
  return (s.strategy ?? "").startsWith("热点") ? "short" : "long";
}

/** 新候选自带 holdDays 优先；旧文件按腿回退，不会把「没有字段」当成 0 天。 */
export function holdDaysOf(s: { leg?: Leg; strategy?: string; holdDays?: number }): number {
  const own = s.holdDays;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return Math.round(own);
  return LEG_HOLD_DAYS[legOf(s)];
}

/** 推送每行末尾的走人字段。 */
export function exitTextOf(s: { leg?: Leg; strategy?: string; holdDays?: number }): string {
  return `走 第${holdDaysOf(s)}日`;
}

/** 一张单子的四个必答：买多少、亏到哪走、赚到哪走、什么时候走。两腿推送共用，别各写一份。 */
export function orderFieldsOf(s: {
  leg?: Leg;
  strategy?: string;
  holdDays?: number;
  buyPrice: number;
  stop?: number | null;
  target?: number | null;
}): string {
  return `买 ${s.buyPrice} | 止损 ${s.stop ?? "—"} | 目标 ${s.target ?? "—"} | ${exitTextOf(s)}`;
}
