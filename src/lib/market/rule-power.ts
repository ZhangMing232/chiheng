/**
 * 判决规则的统计功效校验（2026-11-14）。
 *
 * 这个文件回答一个比「判决结果是什么」更根本的问题：
 * **这套判决规则，有没有能力得出任何可信结论？**
 *
 * 为什么必须有（实测证据）：
 * 2026-11-14 用账本真实数据算了一遍：
 *   - 300 笔已平仓，单笔收益**标准差 10.05%**
 *   - 挑战者规则 `minTrades=12`
 *   - 12 vs 12 的 Welch t 检验，在 alpha=0.05 / power=0.8 下，
 *     **最小可检出均差 = 11.49pp**
 *
 * 而挑战者改的是止损/目标/持有期这类出场参数，实际效果通常只有 2~5pp。
 * 也就是说：**即使挑战者真的更好，12 笔样本也在统计上判不出来**。
 * 这个机制不是「还没攒够样本」，是「攒够了也判不出」。
 *
 * 更难堪的是 `promoteT=1.5`（比常规的 2 还松）：门槛越低，
 * 假阳性越多——在功效不足时降低门槛，等于**把噪声当信号**。
 *
 * 设计纪律：
 * - 纯函数，用标准公式算「最小可检出效应」，不引入统计库依赖。
 * - 只报数字与结论，**不自动改规则**——改门槛要人拍板（改判决口径是拍板项）。
 * - 样本标准差要能传进来（从真实账本算），不写死。
 */

/** 双侧 alpha=0.05 的临界 z（正态近似，n≥10 时够用）。 */
const Z_ALPHA = 1.959964;
/** power=0.8 对应的 z。 */
const Z_POWER = 0.8416212;

export type PowerReport = {
  /** 每侧样本量（挑战者 vs 冠军各这么多） */
  perSide: number;
  /** 单笔收益标准差（小数，0.1005 = 10.05%） */
  sd: number;
  /** 当前判决门槛（Welch t 的 promote/reject 线） */
  thresholdT: number;
  /** 最小可检出的均差（**百分点**，如 11.49 表示 11.49pp） */
  minDetectablePp: number;
  /** 功效够不够：能否检出「实际有效」的差异 */
  verdict: "adequate" | "underpowered" | "unknown";
  /** 一句话结论 */
  reason: string;
  /** 建议（不自动改） */
  advice: string | null;
};

/** 典型出场参数调整的实际效果量级（百分点）。低于这个值等于测不出来。 */
export const TYPICAL_EFFECT_PP = 3;

/**
 * 算「给定样本量与标准差，最小可检出均差」。
 *
 * 公式（两独立样本 Welch t 的近似）：
 *   d = (z_alpha/2 + z_power) * sqrt(2 / n)
 *   均差 = d * sd
 *
 * 为什么用正态近似而不是精确 t 分布：n≥10 时两者差 <5%，
 * 而这个数字是用来「判断量级够不够」的，不是发表论文用的。
 */
export function minDetectableEffectPp(args: { perSide: number; sd: number }): number | null {
  const { perSide, sd } = args;
  if (!Number.isFinite(perSide) || perSide < 2) return null;
  if (!Number.isFinite(sd) || sd <= 0) return null;
  const d = (Z_ALPHA + Z_POWER) * Math.sqrt(2 / perSide);
  return d * sd * 100;
}

/**
 * 综合判断：在给定规则下，这套判决能不能得出可信结论。
 *
 * @param perSide   每侧样本量（用 rule.minTrades）
 * @param sd        单笔收益标准差（从真实账本算）
 * @param thresholdT 当前 promoteT（越低越容易假阳性）
 * @param typicalEffectPp 这类调整的典型真实效果（默认 3pp）
 */
export function evaluateRulePower(args: {
  perSide: number;
  sd: number;
  thresholdT: number;
  typicalEffectPp?: number;
}): PowerReport {
  const typical = args.typicalEffectPp ?? TYPICAL_EFFECT_PP;
  const minPp = minDetectableEffectPp({ perSide: args.perSide, sd: args.sd });

  if (minPp == null) {
    return {
      perSide: args.perSide,
      sd: args.sd,
      thresholdT: args.thresholdT,
      minDetectablePp: 0,
      verdict: "unknown",
      reason: "样本量或标准差无效，算不出功效",
      advice: null,
    };
  }

  // 功效够：能检出比典型效果更小的差异
  if (minPp <= typical) {
    return {
      perSide: args.perSide,
      sd: args.sd,
      thresholdT: args.thresholdT,
      minDetectablePp: minPp,
      verdict: "adequate",
      reason: `每侧 ${args.perSide} 笔可检出 ≥${minPp.toFixed(1)}pp 的差异，小于典型效果 ${typical}pp——功率足够`,
      advice: null,
    };
  }

  // 功效不足：最严重的判断。再分两档给建议。
  const needN = Math.ceil(2 * Math.pow((Z_ALPHA + Z_POWER) * args.sd * 100 / typical, 2));
  return {
    perSide: args.perSide,
    sd: args.sd,
    thresholdT: args.thresholdT,
    minDetectablePp: minPp,
    verdict: "underpowered",
    reason:
      `每侧 ${args.perSide} 笔只能检出 ≥${minPp.toFixed(1)}pp 的差异，` +
      `但这类调整的典型效果约 ${typical}pp——**攒够样本也判不出来**`,
    advice:
      `要把每侧样本提到约 ${needN} 笔才能检出 ${typical}pp 的效果；` +
      (args.thresholdT < 2
        ? `另外当前门槛 t=${args.thresholdT} 比常规 2.0 更松，在功效不足时更容易把噪声当信号，建议同时收紧到 ≥2`
        : `门槛 t=${args.thresholdT} 本身合理，问题只在样本量`),
  };
}
