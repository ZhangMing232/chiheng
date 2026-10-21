/**
 * 这个文件是干什么的：
 * 回测稳健性三件套，算法逐行移植自 Vibe-Trading v0.1.16（HKUDS，MIT）：
 *   - walkForward          ← backtest/validation.py walk_forward_analysis
 *     把一段日度序列切成连续 K 段，逐段算收益/夏普/回撤，看「一致性」——
 *     赚钱靠的是全程都在赚，还是靠其中一段暴走。一致性低 = 结论脆弱。
 *   - bootstrapSharpeCI    ← backtest/validation.py bootstrap_sharpe_ci
 *     对日收益有放回重采样，给出夏普的百分位置信区间和 P(夏普>0)。
 *   - psr / dsr            ← src/quantlib/multipletesting.py
 *     probabilistic_sharpe_ratio：考虑偏度/峰度的「真夏普>基准」概率，
 *     负偏厚尾会让同样的夏普更不可信（分母 1 - g3·SR + (g4-1)/4·SR²）。
 *     deflated_sharpe_ratio：把基准抬到「试了 N 个策略运气最好的那个」，
 *     再算 PSR——试了 N 个因子挑出来的最佳，先过这道运气线再说显著。
 *   - paramSensitivity     ← 邻近参数敏感度网格的思路（Vibe 的邻近参数检验）
 *     给一个基准参数组和一组邻点，逐个评估，看指标在邻域里是平还是悬崖。
 *
 * 纪律（和 6 关判决的关系）：
 * 1. 这一层只做**展示和提示**，不改 6 关判决、不改挑战者 Welch 判决——
 *    判决规则预先登记在代码里，要动规则必须主人拍板。这里算出来的
 *    PSR/DSR/一致性是给主人和 AI 提议看的「第二意见」。
 * 2. 所有函数都是纯函数：同样输入必定同样输出。bootstrap 用固定种子
 *    的 mulberry32（不用 Math.random），单测才能钉死数字。
 * 3. 赤轨的日度序列是「按天等权收益率累加」（不是复利净值），所以
 *    walkForward 的窗口收益用 Σret 而不是净值比——口径不同，结果不能
 *    和复利口径的夏普直接比，页面必须标清。
 * 4. 正态分布的 cdf 用 A&S 26.2.17（|误差|≤7.5e-8），ppf 用 Acklam 逆变换，
 *    不引第三方库。
 */

/** 赤轨日度序列的元素（和 backtest-runs.ts 里 daily 的元素同形）。 */
export type DailyPoint = { date: string; ret: number };

const BARS_PER_YEAR = 252;
/** 正态峰度（非超额），PSR 的默认假设。 */
export const GAUSSIAN_KURTOSIS = 3;
const EULER_MASCHERONI = 0.5772156649015329;
const MIN_OBSERVATIONS = 20;

// ─── 基础统计 ───────────────────────────────────────────────────

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** 三阶标准化矩（偏度），pandas 调整 Fisher-Pearson 校正式。 */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  const m2 = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n; // 有偏方差
  const m3 = xs.reduce((a, b) => a + (b - m) ** 3, 0) / n;
  if (m2 === 0) return 0;
  const g1 = m3 / m2 ** 1.5;
  return ((Math.sqrt(n * (n - 1))) / (n - 2)) * g1;
}

/** 四阶标准化矩（非超额峰度，正态=3），Joanes & Gill (1998) G2 校正式。 */
export function kurtosisOf(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return GAUSSIAN_KURTOSIS;
  const m = mean(xs);
  const m2 = xs.reduce((a, b) => a + (b - m) ** 2, 0) / n; // 有偏方差
  if (m2 === 0) return GAUSSIAN_KURTOSIS;
  const m4 = xs.reduce((a, b) => a + (b - m) ** 4, 0) / n;
  const g2 = m4 / (m2 * m2) - 3; // 有偏超额峰度
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6) + 3;
}

/** 年化夏普（per-period 收益 → 年化）。常数序列没有风险信息，返回 0（不是无穷大）。 */
export function sharpe(returns: number[], barsPerYear: number = BARS_PER_YEAR): number {
  const s = std(returns);
  if (s === 0) return 0;
  return (mean(returns) / (s + 1e-12)) * Math.sqrt(barsPerYear);
}

// ─── 正态 cdf / ppf ─────────────────────────────────────────────

/** 标准正态 cdf：Abramowitz & Stegun 26.2.17，|误差| ≤ 7.5e-8。 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const poly =
    0.31938153 * t - 0.356563782 * t * t + 1.781477937 * t * t * t - 1.821255978 * t ** 4 + 1.330274429 * t ** 5;
  const pdf = Math.exp(-(ax * ax) / 2) / Math.sqrt(2 * Math.PI);
  const v = 1 - pdf * poly;
  // 防尾部浮点把结果推出 [0,1]
  return Math.min(1, Math.max(0, sign > 0 ? v : 1 - v));
}

/** Acklam 逆变换，ppf 精度 ~1e-9。 */
export function normalPpf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`normalPpf: p 必须在 (0,1)，收到 ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pLow) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

// ─── 确定性随机数（mulberry32） ─────────────────────────────────

/** 固定种子 PRNG：bootstrap 要可复现，单测才能钉死输出。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Walk-Forward（移植 validation.py walk_forward_analysis） ───

export type WfWindow = {
  window: number;
  start: string;
  end: string;
  /** 窗口收益 = 窗口内日收益求和（等权累加口径，非净值比） */
  ret: number;
  sharpe: number;
  maxDrawdown: number;
  bars: number;
};

export type WalkForwardResult =
  | {
      nWindows: number;
      windows: WfWindow[];
      profitableWindows: number;
      /** 盈利窗口占比 0-1 */
      consistencyRate: number;
      retMean: number;
      retStd: number;
      sharpeMean: number;
      sharpeStd: number;
    }
  | { error: string };

export function walkForward(daily: DailyPoint[], nWindows = 5): WalkForwardResult {
  if (!Number.isInteger(nWindows) || nWindows < 1) return { error: `nWindows 必须 ≥1，收到 ${nWindows}` };
  if (daily.length < nWindows * 2) return { error: `至少 ${nWindows * 2} 根日线才能切 ${nWindows} 段，只有 ${daily.length} 根` };

  const size = Math.floor(daily.length / nWindows);
  const windows: WfWindow[] = [];
  for (let i = 0; i < nWindows; i++) {
    const s = i * size;
    const e = i < nWindows - 1 ? (i + 1) * size : daily.length;
    const seg = daily.slice(s, e).map((d) => d.ret);
    // 等权累加口径的「窗口净值」：1 + 累计和（只为算回撤画路径，不对外当净值宣传）
    let eq = 1;
    let peak = 1;
    let maxDd = 0;
    for (const r of seg) {
      eq += r;
      if (eq > peak) peak = eq;
      const dd = (eq - peak) / peak;
      if (dd < maxDd) maxDd = dd;
    }
    windows.push({
      window: i + 1,
      start: daily[s]!.date,
      end: daily[e - 1]!.date,
      ret: seg.reduce((a, b) => a + b, 0),
      sharpe: sharpe(seg),
      maxDrawdown: maxDd,
      bars: seg.length,
    });
  }
  const rets = windows.map((w) => w.ret);
  const sharpes = windows.map((w) => w.sharpe);
  const profitable = windows.filter((w) => w.ret > 0).length;
  return {
    nWindows,
    windows,
    profitableWindows: profitable,
    consistencyRate: profitable / nWindows,
    retMean: mean(rets),
    retStd: std(rets),
    sharpeMean: mean(sharpes),
    sharpeStd: std(sharpes),
  };
}

// ─── Bootstrap 夏普置信区间（移植 bootstrap_sharpe_ci） ──────────

export type BootstrapCI =
  | {
      observedSharpe: number;
      ciLow: number;
      ciHigh: number;
      medianSharpe: number;
      /** 重采样里夏普 > 0 的占比 0-1 */
      probPositive: number;
      confidence: number;
      draws: number;
    }
  | { error: string };

export function bootstrapSharpeCI(
  returns: number[],
  opts: { draws?: number; confidence?: number; seed?: number; barsPerYear?: number } = {},
): BootstrapCI {
  const draws = opts.draws ?? 1000;
  const confidence = opts.confidence ?? 0.95;
  const seed = opts.seed ?? 42;
  const bpy = opts.barsPerYear ?? BARS_PER_YEAR;
  if (!Number.isInteger(draws) || draws < 1) return { error: `draws 必须 ≥1，收到 ${draws}` };
  if (!(confidence > 0 && confidence < 1)) return { error: `confidence 必须在 (0,1)，收到 ${confidence}` };
  const clean = returns.filter((r) => Number.isFinite(r));
  if (clean.length < 5) return { error: `至少 5 根收益才能 bootstrap，只有 ${clean.length} 根` };

  const observed = sharpe(clean, bpy);
  const rand = mulberry32(seed);
  const boot: number[] = [];
  for (let d = 0; d < draws; d++) {
    const sample: number[] = new Array(clean.length);
    for (let i = 0; i < clean.length; i++) sample[i] = clean[Math.floor(rand() * clean.length)]!;
    boot.push(sharpe(sample, bpy));
  }
  boot.sort((a, b) => a - b);
  const pct = (p: number) => boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * boot.length)))]!;
  const alpha = (1 - confidence) / 2;
  const probPos = boot.filter((s) => s > 0).length / boot.length;
  return {
    observedSharpe: observed,
    ciLow: pct(alpha),
    ciHigh: pct(1 - alpha),
    medianSharpe: pct(0.5),
    probPositive: probPos,
    confidence,
    draws,
  };
}

// ─── PSR / DSR（移植 multipletesting.py） ───────────────────────

/**
 * PSR：真夏普超过 benchmark 的概率。分母里的偏度/峰度项让它不是普通 t 检验——
 * 负偏 + 厚尾会让同样的夏普更不可信。夏普必须是 per-period（未年化）口径，
 * 赤轨这里传日频夏普/√252。
 */
export function psr(
  observedSharpe: number,
  nObs: number,
  benchmarkSharpe = 0,
  skew = 0,
  kurt = GAUSSIAN_KURTOSIS,
): number {
  if (nObs < MIN_OBSERVATIONS) throw new Error(`PSR 至少 ${MIN_OBSERVATIONS} 个观测，只有 ${nObs}`);
  if (kurt < 1) throw new Error(`kurt 必须是非超额四阶矩（≥1，正态=3），收到 ${kurt}——传的可能是超额峰度`);
  if (!Number.isFinite(observedSharpe)) throw new Error("observedSharpe 必须有限");
  const varianceTerm = 1 - skew * observedSharpe + ((kurt - 1) / 4) * observedSharpe ** 2;
  if (varianceTerm <= 0) throw new Error(`夏普方差项 ${varianceTerm} 非正——偏度/峰度与这个夏普自相矛盾`);
  const stat = ((observedSharpe - benchmarkSharpe) * Math.sqrt(nObs - 1)) / Math.sqrt(varianceTerm);
  return normalCdf(stat);
}

/** 试了 nTrials 个策略、运气最好的那个能拿到的夏普（期望极值近似）。 */
export function expectedMaxSharpe(nTrials: number, trialSharpeStd: number): number {
  if (nTrials < 1) throw new Error(`nTrials 必须 ≥1，收到 ${nTrials}`);
  if (trialSharpeStd < 0) throw new Error(`trialSharpeStd 必须 ≥0，收到 ${trialSharpeStd}`);
  if (nTrials === 1 || trialSharpeStd === 0) return 0;
  const qa = normalPpf(1 - 1 / nTrials);
  const qb = normalPpf(1 - 1 / (nTrials * Math.E));
  return trialSharpeStd * ((1 - EULER_MASCHERONI) * qa + EULER_MASCHERONI * qb);
}

export type DsrResult = {
  observedSharpe: number;
  expectedMaxSharpe: number;
  /** 收缩后的 PSR（真夏普 > 运气线的概率） */
  dsr: number;
  nTrials: number;
  nObs: number;
  survives: boolean;
  confidence: number;
};

/**
 * DSR：把 PSR 的基准从 0 抬到「试 N 个策略的运气极值」，回答
 * 「这个最佳夏普是不是只是搜出来的」。survives = dsr > confidence。
 */
export function dsr(
  observedSharpe: number,
  nTrials: number,
  nObs: number,
  trialSharpeStd: number,
  skew = 0,
  kurt = GAUSSIAN_KURTOSIS,
  confidence = 0.95,
): DsrResult {
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence 必须在 (0,1)，收到 ${confidence}`);
  const bar = expectedMaxSharpe(nTrials, trialSharpeStd);
  const value = psr(observedSharpe, nObs, bar, skew, kurt);
  return {
    observedSharpe,
    expectedMaxSharpe: bar,
    dsr: value,
    nTrials,
    nObs,
    survives: value > confidence,
    confidence,
  };
}

// ─── 邻近参数敏感度网格 ─────────────────────────────────────────

export type SensitivityResult<T> = {
  baseMetric: number;
  results: { params: T; metric: number }[];
  mean: number;
  std: number;
  min: number;
  max: number;
  /**
   * 脆弱判定：邻域内指标变号（有正有负而基准为正），或变异系数 > 1。
   * 参数是悬崖不是平台——这套参数的好成绩可能只是恰好踩在尖上。
   */
  fragile: boolean;
};

export function paramSensitivity<T>(
  baseParams: T,
  neighbors: T[],
  evaluate: (p: T) => number,
): SensitivityResult<T> {
  const baseMetric = evaluate(baseParams);
  const results = neighbors.map((p) => ({ params: p, metric: evaluate(p) }));
  const metrics = results.map((r) => r.metric);
  const m = mean(metrics);
  const s = std(metrics);
  const signFlip = baseMetric > 0 && metrics.some((x) => x < 0);
  const fragile = signFlip || (Math.abs(m) > 1e-12 && s / Math.abs(m) > 1);
  return {
    baseMetric,
    results,
    mean: m,
    std: s,
    min: metrics.length ? Math.min(...metrics) : baseMetric,
    max: metrics.length ? Math.max(...metrics) : baseMetric,
    fragile,
  };
}
