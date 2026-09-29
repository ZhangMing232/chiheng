export const ROUND_TRIP_COST = 0.0015;

export function dayLocked(day: { status?: string; signalTime?: string }): boolean {
  if (day.status === "locked") return true;
  if (day.status === "provisional") return false;
  return (day.signalTime ?? "") >= "14:40";
}

export function netReturn(entry: number, exit: number): number | null {
  if (!(entry > 0) || !(exit > 0)) return null;
  return exit / entry - 1 - ROUND_TRIP_COST;
}
