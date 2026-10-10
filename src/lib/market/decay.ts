/**
 * 这个文件是干什么的：
 * 因子**过关之后**的衰减监控。赤轨原来 `QueueStatus` 里 `passed` 是终点状态——
 * 一个因子过了 6 关就永远占着位置，哪怕它已经失效了。这个文件补上后半段：
 * `passed → monitoring → decayed → 退役`，以及随时可以回来的恢复路径。
 *
 * 你需要知道的：
 * 1. **指标沿用的全部是赤轨自己的 6 关判据，不是 IC/IR 那套**。
 *    赤轨的因子检验产出 `t` / `meanSpread` / `resampleT`（G4 换样本后）/
 *    `gates.g1`（单调性），硬套别家的 IC 体系会失真——那需要另外一整套数据，
 *    而且和「6 关判决」不是同一套口径，两边结论会互相打架。
 * 2. **衰减用比值，不用绝对值**。拿「当前 t」和「这个因子自己过关时的 t」比，
 *    而不是和一个全局阈值比。同一个因子在趋势市和震荡市里绝对值差很多，
 *    但相对自己的基线变弱才是真的在衰减。
 * 3. **翻号比衰减更严重，单独处理成 CRITICAL**。t 值符号和基线相反，
 *    说明这个因子现在是**反向信号**——继续按原方向用会亏钱，这不是"变弱"是"变反"。
 *    赤轨已经吃过这个亏（5 日涨幅两段翻号、威科夫 Spring 高位语义相反）。
 * 4. **降级要连续多次，恢复只要一次**。连续 3 次警告才降级，
 *    但 1 次健康就回升——宁可多留一个暂时回撤的好因子，也不错杀一个。
 *    这条是从 Vibe-Trading 的 `strategy_store/decay.py` 学来的，不是我拍的。
 * 5. 纯逻辑，无 I/O、不碰 fs。测试能直接跑，也不会进 60 秒记账热路径。
 */

/** 四档健康信号，从差到好。比较时取最差的那一个。 */
export type DecaySignal = "critical" | "decayed" | "warning" | "healthy";

/**
 * 衰减生命周期。注意它和 `factor-queue.ts` 的 `QueueStatus` 是**两段**：
 * pending/tested 是"还没过关"，这里的四个是"过关之后"。
 * `retired` 的对口是 `tombstone`——都不再进回测。
 */
export type DecayStatus = "passed" | "monitoring" | "decayed" | "retired";

/**
 * 预先登记的衰减标准。改这里等于改规则本身，要带着理由改——
 * 和 `CHALLENGER_RULE`（challenger.ts）、`STRATEGY_GATE`（strategy-gate.ts）同一个规矩。
 */
export const DECAY_RULE = {
  /** 各比值（当前 / 过关时基线）的三档阈值，从好到差。 */
  tRatio: { healthy: 0.7, warning: 0.5, decayed: 0.3 },
  spreadRatio: { healthy: 0.7, warning: 0.5, decayed: 0.3 },
  resampleRatio: { healthy: 0.7, warning: 0.5, decayed: 0.3 },
  /** passed → monitoring：WARNING 或更差，连续这么多轮。 */
  warningsForMonitoring: 3,
  /** monitoring → decayed：DECAYED 或更差，连续这么多轮。 */
  warningsForDecayed: 2,
  /** decayed → retired：CRITICAL 连续这么多轮。 */
  criticalForRetired: 3,
} as const;

/** 一个因子过关时的基线。过关那一轮的数存下来，之后每轮拿它当尺子。 */
export type DecayBaseline = {
  t: number;
  meanSpread: number;
  /** G4 换样本后的 t。旧批次可能没有，null。 */
  resampleT: number | null;
};

/** 一轮回测结束后喂进来的当前值。拿不到的项给 null，不编数字。 */
export type DecayReading = {
  t: number | null;
  meanSpread: number | null;
  resampleT: number | null;
  /** G1 单调性这一轮还成立吗。null = 这一轮没判。 */
  monotonic: boolean | null;
};

const ORDER: DecaySignal[] = ["critical", "decayed", "warning", "healthy"];

function worst(a: DecaySignal, b: DecaySignal): DecaySignal {
  return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;
}

/**
 * 当前值相对基线的强度比值。
 *
 * 用**绝对值**比：衰减是"变弱"，不分方向（方向由 `direction` 预注册管着）。
 * 基线为 0 时比值没有意义，返回 null 让调用方跳过这一项，而不是算出一个 Infinity。
 */
export function strengthRatio(current: number | null, base: number | null): number | null {
  if (current == null || base == null) return null;
  if (base === 0) return null;
  return Math.abs(current) / Math.abs(base);
}

/**
 * 方向是否反了。t 值符号和基线相反 = 这个因子现在给出的是反向信号。
 * 有一边是 0 时不判翻号——0 是"没测出来"，不是"反了"。
 */
export function isFlipped(current: number | null, base: number | null): boolean {
  if (current == null || base == null) return false;
  if (current === 0 || base === 0) return false;
  return current > 0 !== base > 0;
}

/**
 * 一轮读数 → 健康信号。取所有能算的指标里**最差**的那个。
 *
 * 拿不到就跳过（"if x != null"），**全拿不到返回 healthy**——
 * 没有证据的时候不判死，这条和赤轨其他地方"null 是不知道，不是 0"是同一个规矩。
 */
export function evaluateDecay(reading: DecayReading, baseline: DecayBaseline): DecaySignal {
  // 翻号优先：这是"变反"不是"变弱"，比任何衰减都紧急
  if (isFlipped(reading.t, baseline.t)) return "critical";
  // G1 单调性破了：6 关第一关都不成立，说明分档形状已经散了
  if (reading.monotonic === false) return "critical";

  const signals: DecaySignal[] = [];
  const classify = (value: number | null, rule: { healthy: number; warning: number; decayed: number }) => {
    if (value == null) return null;
    if (value >= rule.healthy) return "healthy" as DecaySignal;
    if (value >= rule.warning) return "warning" as DecaySignal;
    if (value >= rule.decayed) return "decayed" as DecaySignal;
    return "critical" as DecaySignal;
  };

  const t = classify(strengthRatio(reading.t, baseline.t), DECAY_RULE.tRatio);
  if (t) signals.push(t);
  const spread = classify(strengthRatio(reading.meanSpread, baseline.meanSpread), DECAY_RULE.spreadRatio);
  if (spread) signals.push(spread);
  const resample = classify(strengthRatio(reading.resampleT, baseline.resampleT), DECAY_RULE.resampleRatio);
  if (resample) signals.push(resample);

  if (signals.length === 0) return "healthy";
  return signals.reduce(worst);
}

/**
 * 连续信号 → 要不要换状态。返回 null 表示维持原状。
 *
 * `signals` 按时间从旧到新，最后一次是最新一轮。
 */
export function nextDecayStatus(current: DecayStatus, signals: DecaySignal[]): DecayStatus | null {
  if (signals.length === 0) return null;

  // 恢复：只要最新一轮健康就回升。降级要攒够次数，恢复不用——
  // 错杀一个好因子的代价，比多留一个暂时回撤的因子大。
  if (current !== "passed" && signals[signals.length - 1] === "healthy") return "passed";

  if (current === "passed") {
    const need = DECAY_RULE.warningsForMonitoring;
    if (signals.length < need) return null;
    const tail = signals.slice(-need);
    return tail.every((s) => s !== "healthy") ? "monitoring" : null;
  }

  if (current === "monitoring") {
    const need = DECAY_RULE.warningsForDecayed;
    if (signals.length < need) return null;
    const tail = signals.slice(-need);
    return tail.every((s) => s === "decayed" || s === "critical") ? "decayed" : null;
  }

  if (current === "decayed") {
    const need = DECAY_RULE.criticalForRetired;
    if (signals.length < need) return null;
    const tail = signals.slice(-need);
    return tail.every((s) => s === "critical") ? "retired" : null;
  }

  return null;
}

/** 这个状态还要不要进回测。retired 和 decayed 都停下来不再占样本。 */
export function decaysIntoBacktest(status: DecayStatus): boolean {
  return status === "passed" || status === "monitoring";
}
