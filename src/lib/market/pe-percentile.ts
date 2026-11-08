/**
 * 个股自身 PE 历史分位（relValPersist 策略用）。
 *
 * 为什么要有这个模块：value 变体用「PE ≤ 18 绝对阈值」= value trap
 * （绝对便宜 ≠ 相对便宜，低 PE 常是低质量或下行周期）。改成「个股自身 PE 在
 * 过往窗口里的分位」后，**最关键的风险变成了前视**——分位窗口一旦不小心
 * 扫到未来某天的 PE，整个判决就是假的，而且从结果上看不出来（还会显得很漂亮）。
 *
 * 所以这里做成纯函数 + 守门测试：测试里有一条「砍掉未来数据算出来的结果必须
 * 逐点相同」，直接把前视钉死。
 *
 * 口径（与 backtest.ts 的 buildPePctMap 一致）：
 *   - pct    = 中位秩分位（mid-rank）：窗口内「严格小于当前 PE 的个数 + 0.5×相等的个数」
 *              ÷ 窗口内有效 PE 总数 × 100。0 ≈ 自身历史最便宜，100 ≈ 最贵。
 *              用中位秩而不是「≤ 的个数」：PE 长期不变（打平）的股票用「≤」口径
 *              会算成 100%（看起来最贵），其实是「一直如此、无信息」，中位秩给 50% 中性。
 *   - streak = 连续处于低位（pct ≤ cheapThresh）的天数。用来要求「持续便宜」，
 *              排除某天突然掉进便宜区的一次性假信号。
 *   - 窗口   = 含当天在内的最近 windowDays 个**有效** PE 观测（当前 PE 自己也算一个）。
 *   - 有效 PE 观测不足 minWindow 个 → pct = NaN（不可用，不是 0）、streak 归零。
 *     窗口没攒够就出分位是「拿 3 个点说这是历史低位」，没意义。
 *   - PE 为 null（那天没这个数 / 亏损）→ pct = NaN、streak 归零。
 */

/** 一个 PE 观测：date 是交易日（YYYY-MM-DD），pe 为 null 表示当天没有可用 PE。 */
export type PeSeriesEntry = { date: string; pe: number | null };

/** 每个交易日的分位结果。pct 为 NaN 表示当天不可用。 */
export type PePercentilePoint = { pct: number; streak: number };

export type PePercentileOptions = {
  /** 窗口长度（有效 PE 观测个数），默认 250（≈1 年）。 */
  windowDays?: number;
  /** 连续低位的判定阈值（pct ≤ 该值算低位），默认 25（自身历史最便宜的四分位）。 */
  cheapThresh?: number;
  /** 窗口内至少要有这么多有效 PE 观测才出分位，默认 60（≈3 个月）。 */
  minWindow?: number;
  /** 整条 PE 序列少于这么多条观测就不算分位（样本太少），默认 60。 */
  minHistory?: number;
};

const DEFAULT_WINDOW_DAYS = 250;
const DEFAULT_CHEAP_THRESH = 25;
const DEFAULT_MIN_WINDOW = 60;
const DEFAULT_MIN_HISTORY = 60;

/** 升序数组里插入一个值（保持有序）。 */
function sortedInsert(arr: number[], x: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, x);
}

/** 升序数组里删掉一个值（存在才删）。 */
function sortedRemove(arr: number[], x: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo] === x) arr.splice(lo, 1);
}

/**
 * 计算逐日 PE 历史分位。
 *
 * **无前视**：结果只依赖 date 当天及之前的 PE。窗口按日期升序滑动，
 * 任何一天的分位都看不到它之后的任何一条观测。
 */
export function computePePercentiles(
  entries: PeSeriesEntry[],
  opts: PePercentileOptions = {},
): Map<string, PePercentilePoint> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cheapThresh = opts.cheapThresh ?? DEFAULT_CHEAP_THRESH;
  const minWindow = opts.minWindow ?? DEFAULT_MIN_WINDOW;
  const minHistory = opts.minHistory ?? DEFAULT_MIN_HISTORY;

  const out = new Map<string, PePercentilePoint>();
  // 按日期升序处理。日期是 YYYY-MM-DD，字典序 = 时间序，排序后才能滑窗口。
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < minHistory) return out;

  const vals: number[] = []; // 窗口内的有效 PE，升序
  let streak = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const { date, pe } = sorted[i];
    // 滑出窗口外的那条（只滑出，绝不引入未来数据）
    if (i >= windowDays) {
      const oldPe = sorted[i - windowDays].pe;
      if (oldPe != null) sortedRemove(vals, oldPe);
    }
    if (pe == null) {
      out.set(date, { pct: NaN, streak: 0 });
      streak = 0;
      continue;
    }
    sortedInsert(vals, pe);
    const n = vals.length;
    if (n < minWindow) {
      // 窗口没攒够：这个「分位」是拿几个点说事，不给。
      out.set(date, { pct: NaN, streak: 0 });
      streak = 0;
      continue;
    }
    // 中位秩：严格小于的个数 + 0.5×相等的个数
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[mid] < pe) lo = mid + 1;
      else hi = mid;
    }
    const countLess = lo;
    let countEqual = 0;
    while (lo < n && vals[lo] === pe) {
      countEqual += 1;
      lo += 1;
    }
    const pct = ((countLess + 0.5 * countEqual) / n) * 100;
    if (pct <= cheapThresh) streak += 1;
    else streak = 0;
    out.set(date, { pct, streak });
  }
  return out;
}
