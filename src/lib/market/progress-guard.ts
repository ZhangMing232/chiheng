/**
 * 这个文件是干什么的：
 * 「收工守卫」——AI 闭环里，大脑想结束本轮时先由产品查一次：合格才放行，
 * 不合格就拦下并把问题清单交回去继续修；**光转不出东西就停手**。
 *
 * 学的是 Vibe-Research `orchestrator/src/stop_guard.ts`，但只借它的核心判断，
 * 不搬它的六阶段概念（赤轨没有那套 stage 文件）。
 *
 * 你需要知道的（纪律）：
 *
 * 1. **推进感知是这条的灵魂，别退化成计数**。
 *    两次拦截之间，产出**集合变了且条数没减少**才算推进；一旦推进，空转计数**回 1**。
 *    为什么非得这么绕——Vibe 的注释写得很直白：「合规工作流是攒好几轮 calc 才最后一步
 *    写 stage 文件，只数拦截次数会在模型还在攒 calc 时就把预算烧光（2026-09-05 实测）」。
 *    换成赤轨的话：AI 提议因子 → 排队 → 检验，中间好几步都不产生「新提案」。
 *    只数次数，等于在它排队时判它偷懒。
 *
 * 2. **`abort` 不等于「成功也不等于失败」**——它明确是失败，要带着校验错误走，
 *    不许被当成「正常完成」记账。静默降级成完成是最坏的结果：没人知道那轮是空的。
 *
 * 3. 纯函数：不碰 fs / 网络，状态全在传进来的 trace 里，直接单测。
 */

export type GuardOutcome =
  /** 没问题，可以收工 */
  | "allow"
  /** 还有问题，把清单交回大脑接着修 */
  | "block"
  /** 连续空转或拦截到硬上限，终止本轮（判失败，不是正常完成） */
  | "abort";

export type RoundTrace = {
  /** 本轮累计拦截次数 */
  blocks: number;
  /** 连续「无推进」的次数。有推进就回 1，不是回 0 */
  idle: number;
  /** 上一次判定时的产出指纹（已排序）。用它判断有没有推进 */
  lastKeys: string[];
};

export type GuardLimits = {
  /** 连续无推进的上限 */
  maxIdle: number;
  /** 本轮累计拦截的硬上限，不论有没有推进 */
  maxTotal: number;
};

/** 默认值沿用 Vibe（API 大脑：同一段对话里多一轮，代价小）。 */
export const DEFAULT_LIMITS: GuardLimits = { maxIdle: 6, maxTotal: 20 };

export type GuardVerdict = {
  outcome: GuardOutcome;
  /** 推进后的新状态 */
  trace: RoundTrace;
  /** 给人看的判定理由。出问题时要能一眼看懂为什么停 */
  why: string;
};

/** 指纹去重要排序：同样的产出用不同顺序给进来，必须判成同一个集合。 */
function normalize(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

/**
 * 有没有推进。
 *
 * 规则照搬 Vibe：**集合变了 && 条数没减少**。
 * 「条数没减少」这条最难想到但也最要紧——产出变少通常意味着它在删东西/回退，
 * 那不是前进。
 */
export function advanced(before: readonly string[], after: readonly string[]): boolean {
  const oldSet = new Set(before);
  const newSet = new Set(after);
  if (newSet.size < oldSet.size) return false;
  for (const key of newSet) if (!oldSet.has(key)) return true;
  return false;
}

/**
 * 判定本轮该放行、拦下还是终止。
 *
 * @param problems 还差什么。空数组 = 齐了，可以收工。
 * @param keys     当前已产出的合法记录指纹（算 id、提议 id 之类，能表达「多了/少了」就行）
 */
export function judgeRound(
  problems: readonly string[],
  keys: readonly string[],
  trace: RoundTrace,
  limits: GuardLimits = DEFAULT_LIMITS,
): GuardVerdict {
  const nextKeys = normalize(keys);

  // 齐了就放行。产物状态要跟着更新，否则下一轮的第一个产出会被误判成推进。
  if (problems.length === 0) {
    return {
      outcome: "allow",
      trace: { blocks: trace.blocks, idle: 0, lastKeys: nextKeys },
      why: "该有的都有了，收工",
    };
  }

  const moved = advanced(trace.lastKeys, nextKeys);
  const idle = moved ? 1 : trace.idle + 1;
  const blocks = trace.blocks + 1;
  const next: RoundTrace = { blocks, idle, lastKeys: nextKeys };

  if (moved) {
    if (blocks >= limits.maxTotal) {
      return { outcome: "abort", trace: next, why: `累计拦截 ${blocks} 次达硬上限，停下（剩余问题：${problems[0]}）` };
    }
    return { outcome: "block", trace: next, why: `有推进但还差 ${problems.length} 项，继续` };
  }
  if (idle >= limits.maxIdle) {
    return { outcome: "abort", trace: next, why: `连续 ${idle} 次没有新产出，判定空转终止` };
  }
  if (blocks >= limits.maxTotal) {
    return { outcome: "abort", trace: next, why: `累计拦截 ${blocks} 次达硬上限，停下` };
  }
  return { outcome: "block", trace: next, why: `缺少 ${problems.length} 项产出且已连续 ${idle} 次无推进` };
}
