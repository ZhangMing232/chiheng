/**
 * 选股页「现役策略」条该列哪几套。
 *
 * 规矩（2026-11-05 用户点名）：这块只放今天真正在跑、能用的策略。
 * 被策略闸停用的（disabled）不上来，已下线、不在 ACTIVE_STYLES 里的也不上来；
 * 停用原因和冷却进度去「策略管理」页看，不在选股页开头占位置。
 * 和 2026-10-21「筛选条件里不该出现已下线策略」是同一条规矩。
 *
 * 单独抽成纯函数有两个原因：
 * 1. 这块挂在客户端组件里，不能 import 服务端的 strategy-gate.ts——
 *    那边顶层引 node:fs，进客户端包会让整站 hydration 挂掉（10-25 事故）。
 * 2. 这种「只显示在跑的」规则很容易被后来的人改回去，得有测试钉住。
 */

export type GateStateLike = "disabled" | "paroled";
export type GateLike = { state: GateStateLike; since: string; reason: string };

/**
 * 只留没被停用的现役策略。
 *
 * 假释中（paroled）仍在建仓、只是被盯着攒样本，算「在跑在用」，保留并标注。
 * 返回空数组是合法结果：调用方必须显示明确的空态，不许拿空白顶替
 * 「今天全被停了」这件事（拿不到 ≠ 没有）。
 */
export function runningStyles<T extends string>(
  active: readonly T[],
  gates: Record<string, GateLike | undefined>,
): T[] {
  return active.filter((id) => gates[id]?.state !== "disabled");
}
