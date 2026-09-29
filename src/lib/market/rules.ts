/**
 * 这个文件是干什么的：
 * 「启动前期」这一套的门槛。改这里的数字，等于换了一版规则。
 *
 * 你需要知道的：
 * 涨跌幅都是百分比，1.5 表示 1.5%，不是 0.015。
 * 成交额 amountMin 的单位是万元。5000 就是 5000 万元。
 * 其他四套策略不读这些门槛，它们的数字写在 strategies.ts 里。
 */
export type EarlyRules = {
  /** 规则版本。换数字表示这是新的一版，旧样本不能混着比。 */
  version: number;
  /** 今天涨跌幅下限，百分比。低于这个不算「刚启动」。 */
  chgMin: number;
  /** 今天涨跌幅上限，百分比。高于这个就是已经走远，不追。 */
  chgMax: number;
  /** 近 5 日涨跌幅下限，百分比。 */
  d5Min: number;
  /** 近 5 日涨跌幅上限，百分比。 */
  d5Max: number;
  /** 近 20 日涨跌幅下限，百分比。 */
  d20Min: number;
  /** 近 20 日涨跌幅上限，百分比。用来判断「还没走远」。 */
  d20Max: number;
  /** 近 60 日涨跌幅下限，百分比。 */
  d60Min: number;
  /** 近 60 日涨跌幅上限，百分比。 */
  d60Max: number;
  /** 量比下限。1 表示和近期一样。 */
  volMin: number;
  /** 量比上限。太大可能是脉冲，不收。 */
  volMax: number;
  /** 换手率下限，百分比。 */
  turnMin: number;
  /** 换手率上限，百分比。 */
  turnMax: number;
  /** 成交额下限，单位万元。 */
  amountMin: number;
  /** 样本至少要记满这么多个交易日，才谈上涨占比。0 表示不拿天数当开关。 */
  minDays: number;
  /** 至少要有这么多笔能和沪深 300 比的卖出，才谈有没有跑赢。 */
  minClosed: number;
  /** 这版累计回撤超过这个百分比就停止新开仓。 */
  maxDrawdownPct: number;
  /** 连续亏损达到这么多笔就停止新开仓。 */
  maxLosingStreak: number;
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
  maxDrawdownPct: 8,
  maxLosingStreak: 3,
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
  "maxDrawdownPct",
  "maxLosingStreak",
] as const;

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 从网页保存的 JSON 里读规则。缺字段或数字不合法就返回空，调用方继续用旧的。 */
export function parseRules(data: unknown): EarlyRules | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const next = { ...DEFAULT_RULES, version: 1 };
  for (const key of KEYS) {
    const value = num(raw[key]);
    if (value == null) {
      if (key === "maxDrawdownPct" || key === "maxLosingStreak") continue;
      return null;
    }
    next[key] = value;
  }
  if (!(next.chgMin < next.chgMax)) return null;
  if (!(next.d5Min < next.d5Max)) return null;
  if (!(next.d20Min < next.d20Max)) return null;
  if (!(next.d60Min < next.d60Max)) return null;
  if (!(next.volMin < next.volMax)) return null;
  if (!(next.turnMin < next.turnMax)) return null;
  if (!(next.amountMin > 0) || next.minDays < 0 || next.minClosed < 0) return null;
  if (next.maxDrawdownPct < 0 || next.maxDrawdownPct > 100) return null;
  if (next.maxLosingStreak < 0 || next.maxLosingStreak > 20) return null;
  return next;
}

/** 两套门槛的选股数字是否一样。版本号不算，用来判断要不要把旧样本标成另一版。 */
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
