/**
 * 这个文件是干什么的：
 * 回测指标库（对标 Vibe-Research 的 `backtest/metrics.py`，699 行）。
 *
 * 口径逐字对齐（可交叉验证）：
 *   - **sharpe** = mean(日收益) / std(日收益) × √(每年交易日)；std 太平（≤ FLAT_STD）
 *     返回 null——不硬给一个数
 *   - **sortino** 同 sharpe 但分母换下行标准差（只算负收益的均方根）
 *   - **calmar** = 年化收益 / |最大回撤|；回撤 ≈ 0 时 null
 *   - **最大回撤从 initial_cash 起算高水位**：只用观测到的权益会低估第一根的亏损，
 *     权益跌穿 0 之后回撤变得没有意义（它注释原话）
 *   - **盈亏一律按扣费后的 net_pnl**：胜率、盈亏比、profit factor 都用扣费口径
 *
 * 你需要知道的（纪律）：
 * 1. 数据不够就返回 null（不是 0）——0 会被读成「不赚不亏」，其实是没答案。
 * 2. 年化用 252 个交易日（A 股），由调用方按市场传 barsPerYear（港美股 252、
 *    加密 365 之类，别写死）。
 */

/** 年化交易日（A 股/港美股都用 252）。 */
export const DEFAULT_BARS_PER_YEAR = 252;
/** 日收益标准差低于此值视为「平的」，sharpe/sortino 不返回（它 _FLAT_STD）。 */
const FLAT_STD = 1e-10;

export type TradeOutcome = {
  /** 扣费后的盈亏（元） */
  netPnl: number;
  /** 持仓天数（bars） */
  holdingBars: number;
  /** 退出原因（止损/目标/到期等，可选） */
  exitReason?: string;
};

export type TradeStats = {
  n: number;
  winRate: number | null;
  /** 盈亏比 = 平均盈利 / 平均亏损（绝对值） */
  profitLossRatio: number | null;
  /** 最大连续亏损次数 */
  maxConsecutiveLoss: number | null;
  avgHoldingBars: number | null;
  /** profit factor = 总盈利 / 总亏损（绝对值）；没有亏损单时 null */
  profitFactor: number | null;
};

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** 下行标准差：只算负收益（正收益当 0）的均方根。样本量 0 返回 0。 */
export function downsideDeviation(returns: readonly number[]): number {
  const negatives = returns.filter((r) => r < 0);
  if (negatives.length === 0) return 0;
  return Math.sqrt(negatives.reduce((s, r) => s + r * r, 0) / negatives.length);
}

/** 夏普。日收益太平或不足 2 个样本返回 null。 */
export function sharpe(returns: readonly number[], barsPerYear = DEFAULT_BARS_PER_YEAR): number | null {
  if (returns.length < 2) return null;
  const vol = std(returns);
  if (vol <= FLAT_STD) return null;
  return (mean(returns) / vol) * Math.sqrt(barsPerYear);
}

/** 索提诺。没有下行波动（一路不亏）时返回 null——分母 0 不硬算。 */
export function sortino(returns: readonly number[], barsPerYear = DEFAULT_BARS_PER_YEAR): number | null {
  if (returns.length < 2) return null;
  const dd = downsideDeviation(returns);
  if (dd <= FLAT_STD) return null;
  return (mean(returns) / dd) * Math.sqrt(barsPerYear);
}

/**
 * 最大回撤（正数，0.25 = 25%）。initialCash 是第一根之前的高水位——
 * 不用它就会低估第一根的亏损（它注释的坑）。
 */
export function maxDrawdown(equity: readonly number[], initialCash: number): number {
  let peak = initialCash;
  let worst = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    const dd = peak > 0 ? (peak - value) / peak : 0;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** 年化收益（几何）。equity 是逐日权益，initialCash 是起始资金。不足 2 点返回 null。 */
export function annualizedReturn(equity: readonly number[], initialCash: number, barsPerYear = DEFAULT_BARS_PER_YEAR): number | null {
  if (equity.length < 2 || initialCash <= 0 || equity[equity.length - 1]! <= 0) return null;
  const total = equity[equity.length - 1]! / initialCash;
  const years = equity.length / barsPerYear;
  if (years <= 0) return null;
  return Math.pow(total, 1 / years) - 1;
}

/** Calmar = 年化收益 / |最大回撤|。回撤 ≈ 0 时 null（它原样）。 */
export function calmar(equity: readonly number[], initialCash: number, barsPerYear = DEFAULT_BARS_PER_YEAR): number | null {
  const dd = maxDrawdown(equity, initialCash);
  if (dd <= 1e-10) return null;
  const ann = annualizedReturn(equity, initialCash, barsPerYear);
  return ann == null ? null : ann / dd;
}

/** 成交统计（胜率/盈亏比/连亏/持仓/ profit factor）。盈亏一律按扣费后 netPnl。 */
export function tradeStats(trades: readonly TradeOutcome[]): TradeStats {
  if (trades.length === 0) {
    return { n: 0, winRate: null, profitLossRatio: null, maxConsecutiveLoss: null, avgHoldingBars: null, profitFactor: null };
  }
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  let streak = 0;
  let worstStreak = 0;
  for (const t of trades) {
    if (t.netPnl < 0) {
      streak += 1;
      if (streak > worstStreak) worstStreak = streak;
    } else {
      streak = 0;
    }
  }

  return {
    n: trades.length,
    winRate: wins.length / trades.length,
    profitLossRatio: wins.length > 0 && losses.length > 0 ? grossProfit / wins.length / (grossLoss / losses.length) : null,
    maxConsecutiveLoss: worstStreak,
    avgHoldingBars: trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}
