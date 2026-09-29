export const ROUND_TRIP_COST = 0.0015;

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
