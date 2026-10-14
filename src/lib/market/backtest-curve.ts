/**
 * 这个文件是干什么的：
 * 把一次回测运行的**日度序列**摊成四张图要用的曲线——累计收益、回撤、月度、年度。
 *
 * 为什么要它（对标 Vibe-Research 的 backtest 4 图）：
 * 它的回测页有四张图（累计/回撤/月度/年度），赤轨原来一张没有。而赤轨的
 * `runs.jsonl` 里只存了每策略的汇总指标（avgRet/alpha/tStat），**没有日度序列**，
 * 画不出曲线。所以 backtest.ts 落盘时多存一份 daily，这份文件负责把它摊成图。
 *
 * 算法照搬它的 `event_study.py`（Vibe-Research 2.2.1，MIT/上游 fork）：
 * - 累计曲线 = 日收益的 cumsum（它的 `car = ar.cumsum()`）
 * - 平均路径 = 逐列求 mean/median（它的 `_mean_path`）
 * - **少于 MIN_EVENTS 次不给平均**（它的 `MIN_EVENTS = 8`）——几次的平均不是平均，
 *   这条纪律原样搬过来
 *
 * 你需要知道的（赤轨侧的口径，和它不一样的地方）：
 * 1. **赤轨画的是「累计超额」还是「累计收益」？** 两条都给，默认显示累计收益，
 *    因为基准（同期全池）不是一个可投资的序列，超额曲线容易读成"本来能赚这么多"。
 *    要看过剩，切到超额那条——页面要说清差在哪。
 * 2. **等权累加，不是复利**。赤轨的 trades 每笔等权，账本不记仓位大小
 *    （`recentMean` 的注释写了原因：不记仓位是诚实口径）。所以曲线是
 *    Σ(ret)，不是 ∏(1+ret)。**页面上必须标**，不然会读成"净值翻了几倍"。
 * 3. **回撤用绝对回落（百分点），不用比例**。2026-10-14 第一版用了
 *    `(peak - cum) / peak`，结果算出「最大回撤 681.5%」——peak 只有 +5% 而 cum
 *    掉到 -139% 时，分母太小，回撤直接爆炸。等权累加的曲线本来就没有"净值"这个
 *    概念（没有本金），所以回撤只能是"从高点回落了多少个百分点"。
 *    ⚠️ 这跟表格里那个 drawdown **不是同一个口径**：表格用的是复利净值口径
 *    （backtest.ts:drawdownByDay，peak 从 1 起，永远 ≤100%）。两个数字不一样是
 *    故意的，页面要标清，别让人以为有一个算错了。
 * 4. 纯函数零 I/O，测试直接喂序列。
 */

/** 一次运行里一套策略的一天。ret 是小数（0.01 = 1%）。 */
export type DailyPoint = {
  date: string;
  /** 当天所有平仓的等权平均收益 */
  ret: number;
  /** 当天成交笔数（0 笔的日子不该出现——byDay 只统计有成交的天） */
  n: number;
};

export type Curve = {
  dates: string[];
  /** 累计收益（小数）。等权累加，不是复利 */
  cum: number[];
  /** 累计超额（cum 对应的基准累计） */
  cumBench: number[];
  /** 从累计高点的绝对回落（百分点，0 = 在高点）。等权口径，不是表格那个复利口径 */
  dd: number[];
  /** 峰值（画回撤的填充用） */
  peak: number[];
};

export type MonthlyBar = { key: string; ret: number; n: number };
export type YearlyBar = { key: string; ret: number; n: number };

/** 少于这个数的成交日，月度/年度的柱子不给——一个月的几次成交说明不了问题。 */
export const MIN_DAYS_FOR_BAR = 3;

/**
 * 从日度序列摊成曲线。
 *
 * bench 是同日期的基准收益（小数）。没有基准就全 0——**不编一条基准曲线**，
 * 页面会显示"没有基准"而不是画一条平的 0 线冒充。
 */
export function buildCurve(daily: readonly DailyPoint[], bench: readonly DailyPoint[] = []): Curve {
  const benchByDate = new Map(bench.map((b) => [b.date, b.ret]));
  const dates: string[] = [];
  const cum: number[] = [];
  const cumBench: number[] = [];
  const dd: number[] = [];
  const peak: number[] = [];
  let acc = 0;
  let accBench = 0;
  let top = 0;
  for (const point of daily) {
    acc += point.ret;
    accBench += benchByDate.get(point.date) ?? 0;
    // peak 从 0 起：等权累加的策略 cum 第一天可能是负的，从 1 起算会把
    // "小亏"算成 "100% 回撤"。
    if (acc > top) top = acc;
    dates.push(point.date);
    cum.push(round6(acc));
    cumBench.push(round6(accBench));
    peak.push(round6(top));
    // 绝对回落：从历史最高累计收益掉下来多少个百分点。
    // 不用 (peak-cum)/peak——peak 只有几个百分点时分母太小，回撤会算出好几百 %
    dd.push(round6(Math.max(0, top - acc)));
  }
  return { dates, cum, cumBench, dd, peak };
}

/** 按「YYYY-MM」聚合。收益是该月所有成交日的等权平均，不是累加。 */
export function monthlyBars(daily: readonly DailyPoint[]): MonthlyBar[] {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const point of daily) {
    const key = point.date.slice(0, 7);
    const row = buckets.get(key) ?? { sum: 0, n: 0 };
    row.sum += point.ret;
    row.n += 1;
    buckets.set(key, row);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, row]) => ({ key, ret: round6(row.sum / row.n), n: row.n }));
}

/** 按年聚合。口径和月度一样：等权平均，不累加。 */
export function yearlyBars(daily: readonly DailyPoint[]): YearlyBar[] {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const point of daily) {
    const key = point.date.slice(0, 4);
    const row = buckets.get(key) ?? { sum: 0, n: 0 };
    row.sum += point.ret;
    row.n += 1;
    buckets.set(key, row);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, row]) => ({ key, ret: round6(row.sum / row.n), n: row.n }));
}

/**
 * 曲线的一句话摘要：总累计、最大回撤、胜出的月份占比。
 * 没有足够数据时给 null，**不返回 0**——0 会被读成"没赚没亏"。
 */
export function curveSummary(curve: Curve, monthly: readonly MonthlyBar[]): {
  total: number;
  maxDd: number;
  winMonths: number;
  months: number;
} | null {
  if (curve.dates.length === 0) return null;
  const total = curve.cum[curve.cum.length - 1] ?? 0;
  const maxDd = curve.dd.length > 0 ? Math.max(...curve.dd) : 0;
  const winMonths = monthly.filter((m) => m.ret > 0).length;
  return { total, maxDd, winMonths, months: monthly.length };
}

/**
 * 月度/年度柱子的展示过滤：成交日少于 MIN_DAYS_FOR_BAR 的**不画**，
 * 并返回被挡掉的月份，让页面说清"有几个月没画"。
 * 照它的纪律：几次的平均不是平均，画出来比不画更误导。
 */
export function barsToShow(bars: readonly MonthlyBar[]): { show: MonthlyBar[]; hidden: string[] } {
  const show = bars.filter((b) => b.n >= MIN_DAYS_FOR_BAR);
  const hidden = bars.filter((b) => b.n < MIN_DAYS_FOR_BAR).map((b) => b.key);
  return { show, hidden };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
