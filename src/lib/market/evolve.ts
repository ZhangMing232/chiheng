/**
 * 这个文件是干什么的：
 * 进化编排——把因子层和策略层两个闭环串成「一轮完整进化」。先跑因子层（读
 * 6 关判决 + 自我历史 → 提新因子），再跑策略层（读挑战者判决产物 + 刚过 6 关
 * 的因子 → 提名挑战者）。两层各自的权限边界不变（只许提议），这里只负责顺序
 * 和结果汇总。
 *
 * 你需要知道的：
 * 1. 顺序有意义：策略层 prompt 会展示「因子层刚过 6 关的信号」，先跑因子层
 *    意味着当天新过关的因子要等下一轮才被策略层看到——这是有意的，给判决留
 *    出沉淀时间，避免 AI 看到自己刚提议还没验的东西就急着配策略。
 * 2. 自动触发（autoEvolve）走的也是这条编排，trigger = "auto"，两层各记一条账。
 */

import { runFactorAILoop, type AILoopResult } from "./factor-queue.ts";
import { runStrategyAILoop, type StrategyAILoopResult } from "./strategy-ai.ts";
import type { FactorRunRow } from "./factor-runs-file.ts";

export type EvolveResult = {
  factor: AILoopResult;
  strategy: StrategyAILoopResult;
};

/** 跑一轮完整进化：因子层 → 策略层。两层独立成败，一个挂了不影响另一个记账。 */
export async function runEvolveLoop(
  deps: { readRows: () => Promise<{ batch: { rows: FactorRunRow[] } | null }>; existingFactors: { id: string; name: string }[] },
  trigger: "manual" | "auto" = "manual",
): Promise<EvolveResult> {
  const factor = await runFactorAILoop(deps, trigger);
  const strategy = await runStrategyAILoop(trigger);
  return { factor, strategy };
}
