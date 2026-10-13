/**
 * 这个文件是干什么的：
 * 技术指标库（A1，对标 Vibe-Research 的 `calc/indicators.py`，243 行）。
 *
 * **口径与它逐字对齐**（这样两边算出来的数能交叉验证，不是「看起来差不多」）：
 *   - MA：简单均线（默认 5/10/20/60）
 *   - EMA：以首值为种子，k = 2/(n+1)
 *   - MACD：dif = EMA12 − EMA26，dea = EMA9(dif)，hist = (dif − dea) × 2
 *   - RSI：**简单平均（非 Wilder）**，默认 6/12/24
 *   - KDJ：初值 K = D = 50，RSV 按 n 日高低，J = 3K − 2D
 *   - BOLL：**总体标准差**（除以 n，不是 n−1），默认 (20, 2.0)，
 *     bandwidth = (upper − lower) / middle × 100
 *   - 少于 30 根 → not_meaningful（它 MIN_POINTS = 30）
 *
 * 你需要知道的（纪律，照它）：
 * 1. **只给数值，不做解读**。不输出「金叉买入」这类信号——方向判断留给研判页的
 *    证据链，指标本身只是数（它的头注释原话：「不做任何解读」）。
 * 2. **输入校验挡住坏数据**：OHLC 必须自洽（high ≥ low、open/close 在 [low, high] 内）、
 *    价格必须为正。列映射错或坏数据不得伪装成有效指标（它 _rows 的规矩）。
 * 3. 数据不足就 not_meaningful，不硬算——拿 5 根 K 线算 MA60 是自欺。
 */

/** 一根 K 线。字段名与数据源一致（date 是 YYYY-MM-DD）。 */
export type KlineRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** 少于这个根数不给指标（照它的 MIN_POINTS）。 */
export const INDICATOR_MIN_POINTS = 30;

export type IndicatorParams = {
  ma?: readonly number[];
  ema?: readonly number[];
  /** [fast, slow, signal] */
  macd?: readonly [number, number, number];
  rsi?: readonly number[];
  /** [n, m1, m2] */
  kdj?: readonly [number, number, number];
  /** [period, numStd] */
  boll?: readonly [number, number];
};

export type TechnicalIndicators = {
  status: "ok" | "not_meaningful" | "error";
  points: number;
  window?: [string, string];
  ma?: Record<string, number>;
  ema?: Record<string, number>;
  macd?: { dif: number; dea: number; hist: number };
  rsi?: Record<string, number | null>;
  kdj?: { k: number; d: number; j: number } | null;
  boll?: { upper: number; middle: number; lower: number; bandwidthPct: number } | null;
  reason?: string;
};

function ema(values: readonly number[], period: number): number[] {
  const out: number[] = [values[0]!];
  const k = 2 / (period + 1);
  for (let i = 1; i < values.length; i += 1) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** 校验并归一化 K 线行。坏数据抛错（调用方转成 status:"error"）。 */
function validateRows(klines: readonly unknown[]): KlineRow[] {
  if (!Array.isArray(klines) || klines.length === 0) throw new Error("klines 必须是非空的 K 线行列表");
  const out: KlineRow[] = [];
  for (let i = 0; i < klines.length; i += 1) {
    const r = klines[i] as Record<string, unknown> | null;
    if (!r || typeof r !== "object") throw new Error(`klines[${i}] 不是对象`);
    for (const k of ["date", "open", "high", "low", "close"] as const) {
      const v = r[k];
      if (v == null || v === "" || typeof v === "boolean") throw new Error(`klines[${i}] 缺 ${k}`);
    }
    const row: KlineRow = {
      date: String(r.date).slice(0, 10),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    };
    for (const [k, v] of [["open", row.open], ["high", row.high], ["low", row.low], ["close", row.close]] as const) {
      if (!Number.isFinite(v) || v <= 0) throw new Error(`klines[${i}].${k} 非正有限数：${v}`);
    }
    if (row.high < row.low) throw new Error(`klines[${i}] high < low`);
    if (row.open < row.low || row.open > row.high) throw new Error(`klines[${i}].open 不在 [low, high] 内`);
    if (row.close < row.low || row.close > row.high) throw new Error(`klines[${i}].close 不在 [low, high] 内`);
    out.push(row);
  }
  return out;
}

/**
 * 算最新一根的技术指标。口径与 calc/indicators.py 对齐（见头注释）。
 *
 * K 线少于 INDICATOR_MIN_POINTS → status "not_meaningful"（不硬算）。
 */
export function technicalIndicators(klines: readonly unknown[], params: IndicatorParams = {}): TechnicalIndicators {
  const maP = params.ma ?? [5, 10, 20, 60];
  const emaP = params.ema ?? [12, 26];
  const macdP = params.macd ?? [12, 26, 9];
  const rsiP = params.rsi ?? [6, 12, 24];
  const kdjP = params.kdj ?? [9, 3, 3];
  const bollP = params.boll ?? [20, 2];

  let rows: KlineRow[];
  try {
    rows = validateRows(klines);
  } catch (error) {
    return { status: "error", points: 0, reason: error instanceof Error ? error.message : String(error) };
  }

  const n = rows.length;
  if (n < INDICATOR_MIN_POINTS) {
    return { status: "not_meaningful", points: n, reason: `K 线仅 ${n} 根，少于 ${INDICATOR_MIN_POINTS}，指标不可靠` };
  }

  const closes = rows.map((r) => r.close);
  const last = rows[n - 1]!;

  const ma: Record<string, number> = {};
  for (const p of maP) ma[`ma${p}`] = n >= p ? closes.slice(-p).reduce((s, v) => s + v, 0) / p : NaN;

  const emaOut: Record<string, number> = {};
  for (const p of emaP) emaOut[`ema${p}`] = ema(closes, p)[n - 1]!;

  const [f, s, g] = macdP;
  const emaFast = ema(closes, f);
  const emaSlow = ema(closes, s);
  const dif = emaFast.map((v, i) => v - emaSlow[i]!);
  const dea = ema(dif, g);
  const macd = { dif: dif[n - 1]!, dea: dea[n - 1]!, hist: (dif[n - 1]! - dea[n - 1]!) * 2 };

  // RSI 简单平均（非 Wilder）：照它
  const changes = [0, ...closes.map((v, i) => (i === 0 ? 0 : v - closes[i - 1]!))];
  const gains = changes.map((c) => Math.max(c, 0));
  const losses = changes.map((c) => Math.max(-c, 0));
  const rsi: Record<string, number | null> = {};
  for (const p of rsiP) {
    if (n - 1 < p) {
      rsi[`rsi${p}`] = null;
      continue;
    }
    const ag = gains.slice(-p).reduce((a, b) => a + b, 0) / p;
    const al = losses.slice(-p).reduce((a, b) => a + b, 0) / p;
    rsi[`rsi${p}`] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  // KDJ：初值 50/50，RSV 按 n 日高低
  const [kn, m1, m2] = kdjP;
  let kv = 50;
  let dv = 50;
  let kdj: { k: number; d: number; j: number } | null = null;
  for (let i = kn - 1; i < n; i += 1) {
    const window = rows.slice(i - kn + 1, i + 1);
    const hn = Math.max(...window.map((r) => r.high));
    const ln = Math.min(...window.map((r) => r.low));
    const rsv = hn !== ln ? ((rows[i]!.close - ln) / (hn - ln)) * 100 : 50;
    kv = rsv / m1 + kv * (1 - 1 / m1);
    dv = kv / m2 + dv * (1 - 1 / m2);
    kdj = { k: kv, d: dv, j: 3 * kv - 2 * dv };
  }

  let boll: { upper: number; middle: number; lower: number; bandwidthPct: number } | null = null;
  if (n >= bollP[0]) {
    const bw = closes.slice(-bollP[0]);
    const mid = bw.reduce((a, b) => a + b, 0) / bollP[0];
    const std = Math.sqrt(bw.reduce((a, b) => a + (b - mid) ** 2, 0) / bollP[0]); // 总体标准差
    const upper = mid + bollP[1] * std;
    const lower = mid - bollP[1] * std;
    boll = { upper, middle: mid, lower, bandwidthPct: mid ? ((upper - lower) / mid) * 100 : 0 };
  }

  return {
    status: "ok",
    points: n,
    window: [rows[0]!.date, last.date],
    ma,
    ema: emaOut,
    macd,
    rsi,
    kdj,
    boll,
  };
}
