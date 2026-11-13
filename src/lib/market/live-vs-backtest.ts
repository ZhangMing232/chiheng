/**
 * 实盘 vs 回测的背离监控（2026-11-14）。
 *
 * 这个文件解决什么问题：
 * 系统里同时存在两个关于「策略行不行」的真相：
 *   - **回测判决**（`data/strategy-verdicts.json`）：250 日、297 只样本，
 *     说几乎所有策略超额为负、无 alpha；
 *   - **实盘账本**（`data/books/*.json`）：真实交易日里记下的成交，
 *     value 26 笔已平、均值 +0.18%。
 * 两个数字方向相反。这可能是因为：
 *   a) 实盘样本太小（26 笔），+0.18% 纯属运气；
 *   b) 回测口径漏了什么（实盘选的是「当前市场存在的东西」，回测是历史抽样）；
 *   c) 窗口不同（回测 250 日 vs 实盘 22 个交易日）。
 *
 * **不管哪种原因，这个背离本身值得被持续监控**——如果背离长期扩大，
 * 说明回测和实盘有一个在说谎，那时要查的是口径而不是策略。
 *
 * 纪律：
 * - **只报数字与背离，不下「哪个对」的结论**。样本不到 30 笔时明写「样本不足」。
 * - 不自动改任何判据、不触发任何动作——它是个仪表盘，不是开关。
 * - 纯函数算，IO 在调用方；便于单测。
 */

/** 一侧的表现样本。 */
export type SideStats = {
  /** 来源说明（写清是哪个文件、什么窗口） */
  source: string;
  n: number;
  /** 平均每笔收益率（小数） */
  mean: number | null;
  /** 胜率 0~1 */
  winRate: number | null;
  /** 信噪比（只有回测有，实盘算不出稳健 t；null = 没有） */
  tStat: number | null;
};

export type DivergenceVerdict =
  /** 任一侧样本 < MIN_SAMPLE 笔 → 不下结论 */
  | "insufficient"
  /** 两侧方向相反（一个正一个负） */
  | "divergent"
  /** 同向，差距在阈值内 */
  | "aligned"
  /** 同向，但差距超过阈值 */
  | "gap";

/** 每侧最少笔数。低于它就明写「样本不足」——26 笔算不出胜率。 */
export const MIN_SAMPLE = 30;
/** 两侧均值差超过这个值（百分点）算「差距大」。 */
export const GAP_PP = 1.0;

export type DivergenceReport = {
  verdict: DivergenceVerdict;
  backtest: SideStats;
  live: SideStats;
  /** 均值差（live - backtest），百分点；任一侧缺失为 null */
  gapPp: number | null;
  /** 一句话说清结论与依据 */
  reason: string;
  /** 该做什么（只给建议，不自动执行） */
  action: string | null;
};

/**
 * 纯函数：比对两侧表现，判背离。
 *
 * 为什么「样本不足」要单独一个状态而不是并入 aligned：
 * 26 笔的 +0.18% 和 2131 笔的 -0.41% 不是同一个可信度，混在一起说「一致」
 * 会让人以为实盘验证了回测。必须显式区分。
 */
export function compareLiveVsBacktest(args: {
  backtest: SideStats;
  live: SideStats;
}): DivergenceReport {
  const { backtest, live } = args;
  const fmt = (x: number | null) => (x == null ? "?" : `${(x * 100).toFixed(2)}%`);

  // 样本不足：任一侧不够就不判方向。这是最常见的情况（实盘只有 20 来笔）。
  if (backtest.n < MIN_SAMPLE || live.n < MIN_SAMPLE) {
    return {
      verdict: "insufficient",
      backtest,
      live,
      gapPp: null,
      reason: `样本不足（回测 ${backtest.n} 笔 / 实盘 ${live.n} 笔，各需 ≥${MIN_SAMPLE}）——方向的差异还不能算数`,
      action: `继续攒实盘样本；实盘还差 ${Math.max(0, MIN_SAMPLE - live.n)} 笔才有资格和回测比`,
    };
  }

  const bm = backtest.mean ?? 0;
  const lm = live.mean ?? 0;
  const gapPp = (lm - bm) * 100;
  const opposite = bm * lm < 0;

  if (opposite) {
    return {
      verdict: "divergent",
      backtest,
      live,
      gapPp,
      reason: `方向相反：回测 ${fmt(backtest.mean)}（n=${backtest.n}）vs 实盘 ${fmt(live.mean)}（n=${live.n}）——一个说亏一个说赚，其中必有一个口径在骗人`,
      action: "先查口径差异：回测是 250 日抽样 300 只，实盘是当前市场的真实成交；若背离持续 3 个月，重新审视回测的抽样与窗口",
    };
  }

  if (Math.abs(gapPp) > GAP_PP) {
    return {
      verdict: "gap",
      backtest,
      live,
      gapPp,
      reason: `同向但差距大：回测 ${fmt(backtest.mean)} vs 实盘 ${fmt(live.mean)}，差 ${gapPp >= 0 ? "+" : ""}${gapPp.toFixed(2)}pp（阈值 ±${GAP_PP}pp）`,
      action: "差距若持续扩大，说明两侧选到的不是同一批票——核对回测抽样与实盘选股的交集",
    };
  }

  return {
    verdict: "aligned",
    backtest,
    live,
    gapPp,
    reason: `同向且接近：回测 ${fmt(backtest.mean)} vs 实盘 ${fmt(live.mean)}，差 ${gapPp >= 0 ? "+" : ""}${gapPp.toFixed(2)}pp——两侧互相印证`,
    action: null,
  };
}

/**
 * 从逐笔收益算单侧统计（平均 / 胜率）。
 * 为什么单独抽：回测 dump 和账本都要用它，两处各写一份必然漂。
 */
export function sideStats(args: {
  source: string;
  returns: number[];
  tStat?: number | null;
}): SideStats {
  const { source, returns, tStat = null } = args;
  const n = returns.length;
  if (n === 0) return { source, n: 0, mean: null, winRate: null, tStat };
  const mean = returns.reduce((s, v) => s + v, 0) / n;
  const winRate = returns.filter((r) => r > 0).length / n;
  return { source, n, mean, winRate, tStat };
}
