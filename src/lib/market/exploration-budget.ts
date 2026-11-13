/**
 * 探索预算与停机判据（2026-11-14）。
 *
 * 这个文件解决什么问题（用户原话：「等待过程都按照你的建议来执行」）：
 * 现在的进化机制**只会一直找，不会停下来想「找得值不值」**。
 * `evolve-breaker` 只管「连续失败就断电」——但系统可以永远**成功运行**、
 * 永远烧 API 额度、永远找不到 alpha，而熔断器一次都不会触发。
 *
 * 实测（2026-11-14）：
 *   - 31 天烧了 337 次 AI 调用 / $23.20
 *   - 因子队列 89 条里 74 条成了墓碑（83% 失败率）
 *   - 基因组 10 个候选 9 个 rejected（90% 失败率）
 *   - 12 套策略**无一过 |t|≥2**，现役 value 最高也只有 t=1.16
 *
 * 这不是说「不该继续找」——找是对的。问题是**缺少「多久没产出就该降频/停机等人
 * 拍板」的判断**。没有它，系统会无声无息地烧下去，而人不知道它在原地打转。
 *
 * 设计纪律：
 * - **只降频 / 只提醒，不静默停死**。停机要让用户看见并决策，不能悄悄不干活。
 * - 判据用「产出」而不是「消耗」：烧钱本身不是罪，烧了钱没产出才是。
 * - 纯函数，便于单测；IO 与副作用在调用方（record-journal）。
 */

/** 一次「尝试」的结果。因子提名、基因组候选、挑战者转正都算尝试。 */
export type ExplorationAttempt = {
  /** 提交日期 YYYY-MM-DD */
  at: string;
  /** 属于哪条通道 */
  channel: "factor" | "genome" | "strategy";
  /** 结果：promoted 才算「产出」，其余都是「试过但没成」 */
  outcome: "promoted" | "rejected" | "testing" | "tombstone";
};

export type BudgetVerdict =
  /** 有产出，正常探索 */
  | "healthy"
  /** 一段时间没产出，建议降频观察 */
  | "cooldown"
  /** 长期没产出，建议停机等人拍板 */
  | "halt"
  /** 样本太少，不判 */
  | "insufficient";

export type BudgetReport = {
  verdict: BudgetVerdict;
  /** 观察窗口内总尝试数 */
  attempts: number;
  /** 其中成功产出数 */
  promoted: number;
  /** 产出率 0~1 */
  hitRate: number | null;
  /** 距上次产出过了多少天 */
  daysSinceLastHit: number | null;
  /** 一句话结论 */
  reason: string;
  /** 该做什么（给建议，不自动执行） */
  action: string | null;
};

/**
 * 判据（预注册，改它要连测试一起改）：
 * - 观察窗口 30 天：太短会被单个坏周骗，太长反应迟钝。
 * - 至少 20 次尝试才判：低于这个数是「还没试够」，不是「试了没用」。
 * - 连续 21 天无产出 → cooldown（降频：只跑因子层，不跑基因组/策略层）
 * - 连续 45 天无产出 → halt（停机等人，附完整花费与失败明细）
 */
export const BUDGET_RULE = {
  windowDays: 30,
  minAttempts: 20,
  cooldownAfterDays: 21,
  haltAfterDays: 45,
} as const;

/**
 * 纯函数：算探索预算结论。
 *
 * @param attempts 全部尝试记录（任意顺序）
 * @param today   今天（YYYY-MM-DD），显式传入便于测试
 */
export function evaluateExplorationBudget(
  attempts: ExplorationAttempt[],
  today: string,
): BudgetReport {
  const R = BUDGET_RULE;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const windowStart = new Date(todayMs - R.windowDays * 86_400_000).toISOString().slice(0, 10);

  const inWindow = attempts.filter((a) => a.at >= windowStart);
  const promotedAll = attempts.filter((a) => a.outcome === "promoted");

  // 距上次产出：看全部历史，不只看窗口——「多久没赢过」要如实。
  const lastHit = promotedAll.length > 0 ? promotedAll.map((a) => a.at).sort().at(-1)! : null;
  const daysSinceLastHit =
    lastHit == null ? null : Math.floor((todayMs - Date.parse(`${lastHit}T00:00:00Z`)) / 86_400_000);

  const attemptsN = inWindow.length;
  const promotedN = inWindow.filter((a) => a.outcome === "promoted").length;
  const hitRate = attemptsN > 0 ? promotedN / attemptsN : null;

  // 样本太少：还没试够，不判。这是最常见也最重要的分支——
  // 20 次尝试前说「这套没用」等于刚开局就认输。
  if (attemptsN < R.minAttempts) {
    return {
      verdict: "insufficient",
      attempts: attemptsN,
      promoted: promotedN,
      hitRate,
      daysSinceLastHit,
      reason: `${R.windowDays} 天内只试了 ${attemptsN} 次（需 ≥${R.minAttempts}）——还没试够，不判效率`,
      action: null,
    };
  }

  // 长期没产出：按「距上次产出多久」分档。从没产出过就从第一次尝试算起。
  const firstAttempt = attempts.map((a) => a.at).sort()[0] ?? today;
  const daysNoHit =
    daysSinceLastHit ?? Math.floor((todayMs - Date.parse(`${firstAttempt}T00:00:00Z`)) / 86_400_000);

  if (daysNoHit >= R.haltAfterDays) {
    return {
      verdict: "halt",
      attempts: attemptsN,
      promoted: promotedN,
      hitRate,
      daysSinceLastHit,
      reason: `已连续 ${daysNoHit} 天没有任何产出（窗口内 ${attemptsN} 次尝试 0 命中）——超过 ${R.haltAfterDays} 天停机线`,
      action: "建议停掉自动进化等人拍板：先看「为什么一直找不到」而不是继续加试；停机不删任何数据，恢复只需重开开关",
    };
  }

  if (daysNoHit >= R.cooldownAfterDays) {
    return {
      verdict: "cooldown",
      attempts: attemptsN,
      promoted: promotedN,
      hitRate,
      daysSinceLastHit,
      reason: `已连续 ${daysNoHit} 天没有产出（未到 ${R.haltAfterDays} 天停机线）——建议降频观察`,
      action: "降频：只跑因子层（便宜、能积累死因档案），暂停基因组/策略层提名（贵、且当前无可用种子）",
    };
  }

  // 有产出或还在窗口内：正常。顺带报一次命中率，便于人自己判断。
  return {
    verdict: "healthy",
    attempts: attemptsN,
    promoted: promotedN,
    hitRate,
    daysSinceLastHit,
    reason: `窗口内 ${attemptsN} 次尝试产出 ${promotedN} 个（命中率 ${((hitRate ?? 0) * 100).toFixed(0)}%），${daysSinceLastHit == null ? "暂无产出记录" : `距上次产出 ${daysSinceLastHit} 天`}`,
    action: null,
  };
}

/**
 * 从真实数据源收集尝试记录。三条通道分别有各自的「试过」记录：
 * - factor：因子队列（tombstone=试过失败，passed=产出）
 * - genome：基因组候选（rejected/tombstone=失败，promoted=产出）
 * - strategy：挑战者（rejected=失败，promoted=产出）
 *
 * 只读、不写。调用方负责把结果喂给 evaluateExplorationBudget。
 */
export function attemptsFromQueue(args: {
  factorQueue: { id: string; status?: string; createdAt?: string; lastRunAt?: string | null }[];
  genome: { id: string; status?: string; since?: string }[];
}): ExplorationAttempt[] {
  const out: ExplorationAttempt[] = [];
  const mapStatus = (s?: string): ExplorationAttempt["outcome"] | null => {
    if (s === "passed" || s === "promoted") return "promoted";
    if (s === "tombstone" || s === "rejected" || s === "decayed") return "rejected";
    if (s === "testing" || s === "pending" || s === "tested" || s === "monitoring" || s === "proposed") return "testing";
    return null;
  };
  for (const e of args.factorQueue) {
    const o = mapStatus(e.status);
    if (!o) continue;
    out.push({ at: (e.lastRunAt ?? e.createdAt ?? "").slice(0, 10), channel: "factor", outcome: o });
  }
  for (const c of args.genome) {
    const o = mapStatus(c.status);
    if (!o) continue;
    out.push({ at: (c.since ?? "").slice(0, 10), channel: "genome", outcome: o });
  }
  return out.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.at));
}
