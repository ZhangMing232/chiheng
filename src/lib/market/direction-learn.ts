/**
 * 家族级方向学习（方案 C，2026-11-14 第 14 轮）。
 *
 * 解决什么问题（详见 design/AUDIT-2026-11-14.md §12 的统计功效计算）：
 * 挑战者判决是「单变体 vs 冠军」的 Welch t 检验，minTrades=12 时最小可检出
 * 均差 11.49pp，而改止损/持有期的典型效果只有 3pp——**单挑框架下攒够也判不出**。
 * 方案 A（每侧 177 笔 = 8 个月）和方案 B（只判大改动）都绕不开这个框架限制。
 *
 * 方案 C 换问法：不问「这个变体比冠军好多少」，问「**同一类参数调整，
 * 整体是变好了还是变坏了**」。多个变体的样本池化后，同一方向的证据合并，
 * 检出能力大幅提升——这正是多臂老虎机对「方向」的问法。
 *
 * 与现有机制的关系（重要，不改判不越权）：
 * - **不替换**单变体判决：`judgeChallenger` 的 promote/reject 仍是最终转正关卡
 *   （AI-BOUNDARY.md：改判决口径需拍板，这条没动）。
 * - **定位是「方向学习」**：池化结论只喂给 AI 提下一轮提案的方向（建议类），
 *   不自动改任何策略、不自动改任何规则。
 * - **只读账本**，不写盘、不触发任何动作。
 */

/** 一笔可归因的已平仓交易。 */
export type TradeLike = {
  /** 变体 id（账本 variant 字段）；null/undefined = 冠军笔 */
  variant?: string | null;
  /** 策略 id（value/breakout/...） */
  style?: string | null;
  /** 逐笔收益率（小数） */
  ret: number;
  /** 持有天数（可选，方向分析按参数维度分组用） */
  holdDays?: number | null;
  stopPct?: number | null;
  targetPct?: number | null;
};

/** 一个参数维度上的家族（如「止损 8」家族 = 所有 stopPct==8 的变体笔）。 */
export type DirectionFamily = {
  /** 维度名：holdDays / stopPct / targetPct */
  dim: "holdDays" | "stopPct" | "targetPct";
  /** 该档的参数值 */
  value: number;
  /** 样本数（变体侧） */
  n: number;
  /** 变体均值（小数） */
  mean: number | null;
  /** 冠军侧对照均值（同窗口全冠军笔） */
  champMean: number | null;
  /** 超额（变体均值 − 冠军均值），百分点 */
  excessPp: number | null;
};

export type DirectionReport = {
  /** 学到的方向结论（按维度） */
  families: DirectionFamily[];
  /** 一句话给 AI 的方向建议（空的 = 学不到） */
  advice: string | null;
  /** 数据是否够学（低于门槛时 verdict=insufficient） */
  enoughData: boolean;
  /** 变体侧总样本 / 冠军侧总样本 */
  totalVariantN: number;
  totalChampN: number;
};

/**
 * 方向学习需要每侧至少这么多笔才动手——
 * 这个门槛远低于单变体判决的 12 笔，因为**池化**是本方法的意义所在：
 * 3 个止损变体各 4 笔 = 12 笔止损家族样本，足够看方向。
 */
export const MIN_FAMILY_N = 8;
/** 冠军侧对照样本门槛。 */
export const MIN_CHAMP_N = 10;
/** 超额超过这个值（pp）才算「有方向」。低于它 = 这维度看不出方向。 */
export const DIRECTION_THRESHOLD_PP = 1.0;

/**
 * 按参数维度做方向学习（纯函数）。
 *
 * 做法：
 * 1. 变体笔按「参数维度 × 档位」分组（如 stopPct=8 一组、stopPct=10 一组）
 * 2. 每组的均值与冠军侧均值比，得超额
 * 3. 超额超阈值的维度给方向建议
 *
 * 为什么按参数值分组而不是按变体：因为「止损 8%」可能对应多个变体
 * （不同持有期），它们的止损效果是共享的——这正是池化能提升检出力的原因。
 */
export function learnDirection(
  trades: TradeLike[],
  opts: { champStyle?: string } = {},
): DirectionReport {
  const champStyle = opts.champStyle ?? "value";
  // 冠军侧 = 同策略、无 variant 的已平仓笔
  const champRets = trades.filter((t) => !t.variant && t.style === champStyle).map((t) => t.ret);
  const champMean = champRets.length > 0 ? champRets.reduce((s, v) => s + v, 0) / champRets.length : null;

  // 变体笔（有 variant 的）
  const variants = trades.filter((t) => t.variant != null);
  const totalVariantN = variants.length;

  const families: DirectionFamily[] = [];
  const dims: Array<"holdDays" | "stopPct" | "targetPct"> = ["holdDays", "stopPct", "targetPct"];

  for (const dim of dims) {
    // 按「这个维度有值」的变体笔分组
    const byValue = new Map<number, number[]>();
    for (const t of variants) {
      const v = t[dim];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const list = byValue.get(v) ?? [];
      list.push(t.ret);
      byValue.set(v, list);
    }
    for (const [value, rets] of [...byValue.entries()].sort((a, b) => a[0] - b[0])) {
      const n = rets.length;
      const mean = n > 0 ? rets.reduce((s, v) => s + v, 0) / n : null;
      const excessPp = mean != null && champMean != null ? (mean - champMean) * 100 : null;
      families.push({ dim, value, n, mean, champMean, excessPp });
    }
  }

  const totalChampN = champRets.length;
  const enoughData =
    totalVariantN >= MIN_FAMILY_N && totalChampN >= MIN_CHAMP_N;

  // 方向建议：挑「样本够 + 超额超阈值」的档，给出「这个档比冠军好/差」
  const advices: string[] = [];
  if (enoughData) {
    for (const f of families) {
      if (f.n < MIN_FAMILY_N / 2 || f.excessPp == null) continue;
      if (Math.abs(f.excessPp) < DIRECTION_THRESHOLD_PP) continue;
      const good = f.excessPp > 0;
      const dimName = { holdDays: "持有天数", stopPct: "止损", targetPct: "目标" }[f.dim];
      advices.push(
        `${dimName}=${f.value} 的变体（${f.n} 笔）相对冠军超额 ${f.excessPp >= 0 ? "+" : ""}${f.excessPp.toFixed(2)}pp` +
          `——${good ? "这个方向整体比冠军好，值得往这个方向再提" : "这个方向整体跑输，别再往这个方向提"}`,
      );
    }
  }

  const advice =
    !enoughData
      ? null
      : advices.length > 0
        ? advices.join("；")
        : `变体 ${totalVariantN} 笔 / 冠军 ${totalChampN} 笔，但各参数档的超额都落在 ±${DIRECTION_THRESHOLD_PP}pp 内——还看不出方向`;

  return { families, advice, enoughData, totalVariantN, totalChampN };
}
