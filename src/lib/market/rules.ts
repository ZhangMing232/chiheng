export type EarlyRules = {
  version: number;
  chgMin: number;
  chgMax: number;
  d5Min: number;
  d5Max: number;
  d20Min: number;
  d20Max: number;
  d60Min: number;
  d60Max: number;
  volMin: number;
  volMax: number;
  turnMin: number;
  turnMax: number;
  amountMin: number;
  minDays: number;
  minClosed: number;
};

export const DEFAULT_RULES: EarlyRules = {
  version: 1,
  chgMin: 1,
  chgMax: 4.5,
  d5Min: 0,
  d5Max: 8,
  d20Min: -3,
  d20Max: 12,
  d60Min: -10,
  d60Max: 25,
  volMin: 1.2,
  volMax: 2.8,
  turnMin: 1.5,
  turnMax: 12,
  amountMin: 5000,
  minDays: 60,
  minClosed: 20,
};

const KEYS = [
  "chgMin",
  "chgMax",
  "d5Min",
  "d5Max",
  "d20Min",
  "d20Max",
  "d60Min",
  "d60Max",
  "volMin",
  "volMax",
  "turnMin",
  "turnMax",
  "amountMin",
  "minDays",
  "minClosed",
] as const;

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseRules(data: unknown): EarlyRules | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const next = { ...DEFAULT_RULES, version: 1 };
  for (const key of KEYS) {
    const value = num(raw[key]);
    if (value == null) return null;
    next[key] = value;
  }
  if (!(next.chgMin < next.chgMax)) return null;
  if (!(next.d5Min < next.d5Max)) return null;
  if (!(next.d20Min < next.d20Max)) return null;
  if (!(next.d60Min < next.d60Max)) return null;
  if (!(next.volMin < next.volMax)) return null;
  if (!(next.turnMin < next.turnMax)) return null;
  if (!(next.amountMin > 0) || next.minDays < 0 || next.minClosed < 0) return null;
  return next;
}

export function sameSelection(a: EarlyRules, b: EarlyRules): boolean {
  return (
    a.chgMin === b.chgMin &&
    a.chgMax === b.chgMax &&
    a.d5Min === b.d5Min &&
    a.d5Max === b.d5Max &&
    a.d20Min === b.d20Min &&
    a.d20Max === b.d20Max &&
    a.d60Min === b.d60Min &&
    a.d60Max === b.d60Max &&
    a.volMin === b.volMin &&
    a.volMax === b.volMax &&
    a.turnMin === b.turnMin &&
    a.turnMax === b.turnMax &&
    a.amountMin === b.amountMin
  );
}
