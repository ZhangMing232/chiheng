/**
 * 这个文件是干什么的：
 * 回测页的视图层——把一次运行（runs.jsonl 的一行）摊成能看的表。
 *
 * 这一页要表达的核心纪律：**两次运行的数字能不能比，取决于口径一样不一样。**
 * 成本口径改过一次（0.102% → 0.302%），旧数字全部失效。所以页面不把运行历史
 * 摆成一条曲线让人看趋势，而是先把口径摊开——口径不同的两次运行之间，明确标出
 * 「不可比」，别让人拿它们的高低当结论。
 *
 * 你需要知道的：
 * 1. 纯函数，不碰 fs。
 * 2. 排序缺值沉底、t 值低的沉底（|t| < 2 等于没测出来，不该排在最前面）。
 * 3. 「可不可比」的判定就是 env 逐字段比：区间、撮合口径、费用、闸口、样本量。
 *    样本量不同也不可比——300 只和 60 只的结论不是一回事。
 */

import type { BacktestEnv, BacktestRun, BacktestStyleStat } from "./backtest-runs.ts";

/** 口径的差异清单。空数组 = 两次运行可以直接比。 */
export function envDiff(a: BacktestEnv, b: BacktestEnv): string[] {
  const out: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  if (a.start !== b.start || a.end !== b.end) out.push(`区间 ${a.start}~${a.end} vs ${b.start}~${b.end}`);
  if (a.fillMode !== b.fillMode) out.push(`入场撮合口径 ${a.fillMode} vs ${b.fillMode}`);
  if (Math.abs(a.fee - b.fee) > 1e-9) out.push(`一来一回成本 ${pct(a.fee)} vs ${pct(b.fee)}`);
  if (a.turnoverGate !== b.turnoverGate) out.push(`换手率闸 ${a.turnoverGate ? "开" : "关"} vs ${b.turnoverGate ? "开" : "关"}`);
  if (a.covered !== b.covered) out.push(`取到日线 ${a.covered} 只 vs ${b.covered} 只`);
  if ((a.stopPct ?? null) !== (b.stopPct ?? null)) out.push(`止损 ${a.stopPct ?? "默认"}% vs ${b.stopPct ?? "默认"}%`);
  return out;
}

/** 两次运行是否可比。 */
export function comparable(a: BacktestRun, b: BacktestRun): boolean {
  return envDiff(a.env, b.env).length === 0;
}

export type RunSummary = {
  ranDate: string;
  /** 一行摘要，给列表用 */
  text: string;
  /** 这次跑的是什么口径（费用/撮合/样本），列表里要看得见 */
  envText: string;
  /** 样本太小（< 50 只）时给 warn：结论不足以做统计 */
  thin: boolean;
};

const MIN_COVERED = 50;

export function runSummary(run: BacktestRun): RunSummary {
  const env = run.env;
  return {
    ranDate: run.ranDate,
    text: `${run.styles.length} 套策略 · 同期沪深300 ${(env.bench300 * 100).toFixed(1)}%`,
    envText: `撮合 ${env.fillMode} · 成本 ${(env.fee * 100).toFixed(3)}% · 样本 ${env.covered} 只${env.turnoverGate ? " · 换手闸开" : " · 换手闸关"}`,
    thin: env.covered < MIN_COVERED,
  };
}

export type SortKey = "alpha" | "tStat" | "trades" | "winRate";

/** 一次运行里的策略表，按指定键排。|t| < 2 的沉底（没测出来的超额不算数）。 */
export function styleRows(run: BacktestRun, by: SortKey = "alpha"): BacktestStyleStat[] {
  const out = [...run.styles];
  out.sort((a, b) => {
    const ma = by === "tStat" && Math.abs(a.tStat) < 2;
    const mb = by === "tStat" && Math.abs(b.tStat) < 2;
    if (ma !== mb) return ma ? 1 : -1;
    let d: number;
    if (by === "tStat") d = Math.abs(a.tStat) - Math.abs(b.tStat);
    else if (by === "trades") d = a.trades - b.trades;
    else if (by === "winRate") d = a.winRate - b.winRate;
    else d = a.alpha - b.alpha;
    return -d;
  });
  return out;
}

/**
 * 这次运行里 |t| < 2 的策略——「没测出来」，页面要单独点出来。
 * 它们的超额和 0 分不开，写成「有效」就是自欺。
 */
export function untested(run: BacktestRun): BacktestStyleStat[] {
  return run.styles.filter((s) => Math.abs(s.tStat) < 2);
}