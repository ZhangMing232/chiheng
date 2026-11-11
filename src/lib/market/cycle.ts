/**
 * 这个文件是干什么的：
 * 「情绪周期」的纯计算层——只做算术，不读盘、不联网、不取当前时间。
 * 生成脚本 `scripts/cycle-history.ts` 拿它算历史序列，`/cycle` 页面拿它算表格。
 *
 * 三条口径必须写死在这里，因为页面和脚本两处都要用同一套，不能各写一份：
 *
 * 1. **涨停阈值按板块取值**：创业板/科创板 19.5%，其余 9.5%。
 *    这是近似——ST 的 5% 没有历史逐日的 ST 标记可用，所以 ST 会被漏计或误计。
 *    同样的近似 `scripts/ladder-3day.ts` 里也有，两处不可分叉。
 *
 * 2. **温度分位只用当日及以前**。`medianRank` 的窗口是「截至当日」，不是整段历史。
 *    用整段历史做分位 = 前视（今天的分位会随明天的高点变化），那种错不但错，
 *    还会让回测看起来更漂亮。测试里专门有一条守这个。
 *
 * 3. **阶段是推导出来的，不是外部标准**。`phaseOf` 拿温度档位 + 近 5 日温度变化
 *    定六档。这是我们的口径，页面必须标「口径见下」，不能包装成行业通用结论。
 */

/** 六档阶段。与温度五档（冰点/偏冷/温和/过热/沸点）不是同一个概念。 */
export type Phase = "冰点" | "修复" | "升温" | "高潮" | "降温" | "退潮";

export const PHASES: Phase[] = ["冰点", "修复", "升温", "高潮", "降温", "退潮"];

/** 阶段 → Tailwind 色名（styles.css 里的 --color-phase-*）。 */
export const PHASE_TONE: Record<Phase, string> = {
  冰点: "phase-ice",
  修复: "phase-fix",
  升温: "phase-up",
  高潮: "phase-top",
  降温: "phase-cool",
  退潮: "phase-ebb",
};

/** 一天的横截面结构。全部是「收盘那一刻就能算出来」的量，不含未来。 */
export type DayStat = {
  date: string;
  /** 涨停家数 */
  limitUp: number;
  /** 连板家数（连续 ≥2 天涨停） */
  ladder: number;
  /** 最高连板数 */
  maxStreak: number;
  /** 板位分布：streak → 家数（只到 maxStreak，首板单列在 1） */
  byTier: Record<string, number>;
  /** 上涨家数 / 下跌家数（当日涨跌幅符号，平盘不计） */
  up: number;
  down: number;
  /** 全池等权当日涨跌幅（小数，0.012 = +1.2%） */
  eqReturn: number;
  /** 有效样本数（当日有行情的股票数） */
  n: number;
  /** 温度 0–100（分位合成，见 temperatureOf） */
  temp: number;
  /** 阶段 */
  phase: Phase;
  /** 近 5 日温度变化（温度差分，不是收益） */
  tempDelta5: number;
};

/** 中位秩分位：严格小于的个数 + 0.5×相等的个数，再除以样本数。返回 0–100。 */
export function medianRank(window: readonly number[], value: number): number {
  if (window.length === 0) return 50;
  let less = 0;
  let equal = 0;
  for (const v of window) {
    if (v < value) less += 1;
    else if (v === value) equal += 1;
  }
  return ((less + 0.5 * equal) / window.length) * 100;
}

/**
 * 温度（0–100）：四个同日可得的量各取「截至当日」的滚动中位秩，加权。
 *
 * 为什么不用绝对阈值：涨停 60 家在不同年份的含义完全不同（2015 和 2024 不是一个尺度），
 * 分位化之后才有跨年可比性。窗口取 250 日，不足 120 日返回 null——样本不够就别给分。
 */
export function temperatureOf(
  today: { limitUp: number; ladder: number; maxStreak: number; up: number; down: number },
  history: readonly { limitUp: number; ladder: number; maxStreak: number; up: number; down: number }[],
): number | null {
  if (history.length < 120) return null;
  const upRatio = today.up + today.down > 0 ? today.up / (today.up + today.down) : 0;
  const histRatio = history.map((h) => (h.up + h.down > 0 ? h.up / (h.up + h.down) : 0));
  const score =
    medianRank(history.map((h) => h.limitUp), today.limitUp) * 0.35 +
    medianRank(history.map((h) => h.ladder), today.ladder) * 0.25 +
    medianRank(history.map((h) => h.maxStreak), today.maxStreak) * 0.2 +
    medianRank(histRatio, upRatio) * 0.2;
  return Math.round(score * 10) / 10;
}

/**
 * 温度 + 5 日变化 → 六档阶段。
 *
 * 分界线是拍出来的（25 / 50 / 75），不是拟合出来的：拟合边界会让「阶段」变成
 * 一个恰好描述过去的分类器，看起来准、实际没有预测力。这里刻意用整数分界，
 * 好处是人能记住、能反驳。
 */
export function phaseOf(temp: number | null, tempDelta5: number): Phase | null {
  if (temp == null) return null;
  if (temp < 25) return "冰点";
  if (temp < 50) return tempDelta5 >= 0 ? "修复" : "退潮";
  if (temp < 75) return tempDelta5 >= 0 ? "升温" : "降温";
  return "高潮";
}

/** 板位分布：把「连续涨停天数」列表折成 {1: n, 2: n, ...}，超过 9 板并到 "9"。 */
export function tierOf(streaks: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of streaks) {
    if (s <= 0) continue;
    const key = String(Math.min(s, 9));
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 晋级率：昨日 N 板里，今天变成 N+1 板的比例。返回 {total, promoted, rate}。 */
export function promotion(
  prevTier: Record<string, number>,
  todayTier: Record<string, number>,
  tier: number,
): { total: number; promoted: number; rate: number | null } {
  const total = prevTier[String(tier)] ?? 0;
  // 今天在 N+1 板的家数不可能超过昨天 N 板的家数；超出只可能是数据错，夹回来。
  const promoted = Math.min(total, todayTier[String(tier + 1)] ?? 0);
  return { total, promoted, rate: total > 0 ? promoted / total : null };
}

export type TransferCell = { from: Phase; to: Phase; count: number; rate: number };

/**
 * 阶段转移矩阵：今天某阶段，次日落在各阶段的历史次数与占比。
 * 只统计**相邻交易日**且两天都有阶段的样本。
 */
export function transferMatrix(series: readonly DayStat[]): TransferCell[] {
  const counts = new Map<string, number>();
  const rowTotal = new Map<Phase, number>();
  for (let i = 1; i < series.length; i += 1) {
    const a = series[i - 1]?.phase;
    const b = series[i]?.phase;
    if (!a || !b) continue;
    counts.set(`${a}|${b}`, (counts.get(`${a}|${b}`) ?? 0) + 1);
    rowTotal.set(a, (rowTotal.get(a) ?? 0) + 1);
  }
  const out: TransferCell[] = [];
  for (const from of PHASES) {
    const total = rowTotal.get(from) ?? 0;
    for (const to of PHASES) {
      const count = counts.get(`${from}|${to}`) ?? 0;
      out.push({ from, to, count, rate: total > 0 ? count / total : 0 });
    }
  }
  return out;
}

/**
 * 历史同景：处在某阶段的那一天，次日全池等权涨跌的分布。
 * `series` 里 eqReturn 必须是当日收益，次日收益取 series[i+1].eqReturn。
 * 样本 <30 时仍返回数字，但 `reliable=false`，页面必须标「样本不足」。
 */
export function nextDayOutcome(
  series: readonly DayStat[],
  phase: Phase,
): { n: number; winRate: number | null; mean: number | null; reliable: boolean } {
  const rets: number[] = [];
  for (let i = 0; i < series.length - 1; i += 1) {
    if (series[i]?.phase !== phase) continue;
    const next = series[i + 1];
    if (!next || !Number.isFinite(next.eqReturn)) continue;
    rets.push(next.eqReturn);
  }
  const n = rets.length;
  if (n === 0) return { n: 0, winRate: null, mean: null, reliable: false };
  const wins = rets.filter((r) => r > 0).length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  return { n, winRate: wins / n, mean, reliable: n >= 30 };
}
