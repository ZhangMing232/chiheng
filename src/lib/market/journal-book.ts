export const ROUND_TRIP_COST = 0.0015;
export const LIVE_MIN_DAYS = 60;
export const LIVE_MIN_CLOSED = 20;

export function liveGate(days: number, closed: { ret: number | null; indexRet: number | null }[]): { ok: boolean; reason: string } {
  if (days < LIVE_MIN_DAYS) return { ok: false, reason: `交易日记录 ${days}/${LIVE_MIN_DAYS}` };
  const paired = closed.filter((trade) => trade.ret != null && trade.indexRet != null);
  if (paired.length < LIVE_MIN_CLOSED) return { ok: false, reason: `能对比沪深300的闭环 ${paired.length}/${LIVE_MIN_CLOSED}` };
  const excess = paired.reduce((sum, trade) => sum + (trade.ret! - trade.indexRet!), 0) / paired.length;
  if (!(excess > 0)) return { ok: false, reason: "扣费后没有跑赢沪深300" };
  return { ok: true, reason: "可以按计划的小仓位做，不要加大" };
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
