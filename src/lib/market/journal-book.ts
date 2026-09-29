import { DEFAULT_RULES, type EarlyRules } from "./rules.ts";
import { HOLD_SESSIONS } from "./model.ts";

/** 卖出印花税万五，佣金万二点五双边，过户费万零点一双边。没有按股数计「不足 5 元收 5 元」。 */
export const ROUND_TRIP_COST = 0.00025 * 2 + 0.0005 + 0.00001 * 2;
export { HOLD_SESSIONS };

function normDay(value: string): string {
  const match = value.match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

export function exitFill(
  bars: { date: string; h?: number; l?: number; c: number }[],
  entryDate: string,
  entry: number,
  stop: number,
  target: number,
  limitPct = 10,
  sessions = HOLD_SESSIONS,
): { date: string; price: number; reason: "target" | "stop" | "time" } | null {
  const start = bars.findIndex((bar) => normDay(bar.date) === normDay(entryDate));
  if (start < 0 || !(entry > 0) || !(stop > 0) || !(target > stop)) return null;
  let prev = bars[start].c;
  let left = sessions;
  let extra = 5;
  for (let cursor = start + 1; cursor < bars.length && (left > 0 || extra > 0); cursor += 1) {
    const bar = bars[cursor];
    const down = Math.round(prev * (1 - limitPct / 100) * 100) / 100;
    const sealedDown = down > 0 && bar.c <= down + 0.01 && (bar.h == null || bar.h <= down + 0.01);
    prev = bar.c;
    if (sealedDown) {
      if (left > 0) left -= 1;
      else extra -= 1;
      continue;
    }
    const last = left === 1;
    if (left > 0) left -= 1;
    else extra -= 1;
    const high = bar.h != null && bar.h > 0 ? bar.h : bar.c;
    const low = bar.l != null && bar.l > 0 ? bar.l : bar.c;
    // 买入当日不在这个循环里，满足 T+1。同一天两边都碰到，按先止损。
    if (low <= stop) return { date: normDay(bar.date), price: stop, reason: "stop" };
    if (high >= target) return { date: normDay(bar.date), price: target, reason: "target" };
    if ((last || left < 0) && bar.c > 0) return { date: normDay(bar.date), price: bar.c, reason: "time" };
  }
  return null;
}

export function nthClose(
  bars: { date: string; c: number }[],
  entryDate: string,
  sessions = HOLD_SESSIONS,
): { date: string; price: number } | null {
  const start = bars.findIndex((bar) => normDay(bar.date) === normDay(entryDate));
  if (start < 0) return null;
  let left = sessions;
  for (let cursor = start + 1; cursor < bars.length && left > 0; cursor += 1) {
    left -= 1;
    if (left === 0 && bars[cursor].c > 0) return { date: normDay(bars[cursor].date), price: bars[cursor].c };
  }
  return null;
}

export function maxDrawdown(returns: number[]): number {
  let peak = 0;
  let equity = 0;
  let worst = 0;
  for (const value of returns) {
    equity += value;
    if (equity > peak) peak = equity;
    worst = Math.max(worst, peak - equity);
  }
  return worst;
}

export function losingStreak(returns: number[]): number {
  let streak = 0;
  for (let index = returns.length - 1; index >= 0; index -= 1) {
    if (returns[index] < 0) streak += 1;
    else break;
  }
  return streak;
}

/** 真钱开关。天数和笔数不够、没跑赢指数、连亏或回撤过大，都不开。 */
export function liveGate(
  days: number,
  closed: { ret: number | null; indexRet: number | null }[],
  orderedReturns: number[],
  rules: Pick<EarlyRules, "minDays" | "minClosed" | "maxDrawdownPct" | "maxLosingStreak"> = DEFAULT_RULES,
): { ok: boolean; reason: string } {
  const streak = losingStreak(orderedReturns);
  if (rules.maxLosingStreak > 0 && streak >= rules.maxLosingStreak) {
    return { ok: false, reason: `这版已连续亏损 ${streak} 笔，先停止新开仓` };
  }
  const drawdown = maxDrawdown(orderedReturns);
  if (rules.maxDrawdownPct > 0 && orderedReturns.length >= 5 && drawdown > rules.maxDrawdownPct / 100) {
    return { ok: false, reason: `这版回撤 ${(drawdown * 100).toFixed(1)}%，超过 ${rules.maxDrawdownPct}%，先停止新开仓` };
  }
  if (rules.minDays > 0 && days < rules.minDays) return { ok: false, reason: `交易日记录 ${days}/${rules.minDays}` };
  const paired = closed.filter((trade) => trade.ret != null && trade.indexRet != null);
  if (rules.minClosed > 0 && paired.length < rules.minClosed) {
    return { ok: false, reason: `能对比沪深300的闭环 ${paired.length}/${rules.minClosed}` };
  }
  if (rules.minClosed > 0 && paired.length > 0) {
    const excess = paired.reduce((sum, trade) => sum + (trade.ret! - trade.indexRet!), 0) / paired.length;
    if (!(excess > 0)) return { ok: false, reason: "扣费后没有跑赢沪深300" };
  }
  if (rules.minDays === 0 && rules.minClosed === 0) return { ok: true, reason: "样本检验已关掉。连亏和回撤仍会停手" };
  return { ok: true, reason: "可以按计划的小仓位做。连亏或回撤变大就会再关上" };
}

export function dayLocked(day: { status?: string; signalTime?: string }): boolean {
  if (day.status === "locked") return true;
  if (day.status === "provisional") return false;
  return (day.signalTime ?? "") >= "14:40";
}

export function lotShares(budget: number, price: number): number {
  if (!(budget > 0) || !(price > 0)) return 0;
  return Math.floor(budget / price / 100) * 100;
}

export function stopPrice(entry: number, maxLossPct: number): number | null {
  if (!(entry > 0) || !(maxLossPct > 0) || maxLossPct >= 100) return null;
  return entry * (1 - maxLossPct / 100);
}

export function yuan(amount: number): string {
  if (!Number.isFinite(amount)) return "—";
  const sign = amount < 0 ? "-" : "";
  return `${sign}¥${Math.abs(amount).toFixed(0)}`;
}

export function netReturn(entry: number, exit: number): number | null {
  if (!(entry > 0) || !(exit > 0)) return null;
  return exit / entry - 1 - ROUND_TRIP_COST;
}
