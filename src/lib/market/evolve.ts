/**
 * 这个文件是干什么的：
 * 进化编排——把 AI 大脑的三层串成「一轮完整进化」的 harness 闭环：
 *   ① 观察（agent-loop 全局诊断，只诊断不行动，建议落 agent-diagnosis.json）
 *   ② 计划/行动（因子层：读 6 关判决 + 自我历史 + 诊断建议 → 提新因子）
 *   ③ 行动（策略层：读挑战者判决产物 + 刚过 6 关的因子 + 诊断建议 → 提名挑战者）
 * 判决永远不在编排里：6 关/Welch 写死在代码里，由回测和记账进程执行
 * （AI-BOUNDARY.md），编排只负责顺序和结果汇总。
 *
 * 你需要知道的：
 * 1. **诊断先行有意义**：两层 prompt 经 fetchDiagnosisHints 读最近一次诊断的
 *    suggestions。诊断跑在提议前面，本轮提议就能看到「今天刚出的建议」；
 *    诊断挂在提议后面，建议永远滞后一轮。observe → plan → act 的顺序就是这么落实的。
 * 2. **诊断挂了不连坐**：observe 失败（接口欠费/返回非法）记进 ai-log，
 *    不妨碍 plan/act 照常跑——它只是校准项不是依赖项，结果里如实记 null。
 * 3. 三个步骤都可注入（opts.diagnose/runFactor/runStrategy）：测试用假实现
 *    钉死顺序和容错，生产用默认的真实现。
 * 4. 自动触发（autoEvolve，scripts/record-journal.ts 收盘后调度）走的也是
 *    这条编排，trigger = "auto"，各层记各层的账。
 */

import { runFactorAILoop, type AILoopResult } from "./factor-queue.ts";
import { runStrategyAILoop, type StrategyAILoopResult } from "./strategy-ai.ts";
import { runAgentDiagnosis, type AgentLoopResult } from "./agent-loop.ts";
import type { FactorRunRow } from "./factor-runs-file.ts";

export type EvolveResult = {
  /** 观察层：null = 这轮没诊断成（挂了/没配接口），如实记，不冒充。 */
  agent: AgentLoopResult | null;
  factor: AILoopResult;
  strategy: StrategyAILoopResult;
};

export type EvolveDeps = {
  readRows: () => Promise<{ batch: { rows: FactorRunRow[] } | null }>;
  existingFactors: { id: string; name: string }[];
};

/** 各层都可替换（测试注入假实现）；缺省用真实现。 */
export type EvolveOpts = {
  diagnose?: () => Promise<AgentLoopResult>;
  runFactor?: (trigger: "manual" | "auto") => Promise<AILoopResult>;
  runStrategy?: (trigger: "manual" | "auto") => Promise<StrategyAILoopResult>;
};

/** 跑一轮完整进化：诊断（观察）→ 因子层 → 策略层。各层独立成败，互不断电。 */
export async function runEvolveLoop(
  deps: EvolveDeps,
  trigger: "manual" | "auto" = "manual",
  opts: EvolveOpts = {},
): Promise<EvolveResult> {
  // ① 观察：全局诊断先行——建议落盘，本轮两层 prompt 的 diagnosisHints 就能读到。
  let agent: AgentLoopResult | null = null;
  try {
    agent = await (opts.diagnose ?? (() => runAgentDiagnosis(trigger)))();
  } catch {
    agent = null; // 诊断层自己记 ai-log；这里兜底异常形态，绝不让观察层拖死行动层。
  }
  // ②③ 计划/行动：两层顺序照旧（策略层看因子层上一轮的沉淀，不看当轮——给判决留时间）。
  const runFactor = opts.runFactor ?? ((t: "manual" | "auto") => runFactorAILoop(deps, t));
  const runStrategy = opts.runStrategy ?? ((t: "manual" | "auto") => runStrategyAILoop(t));
  const factor = await runFactor(trigger);
  const strategy = await runStrategy(trigger);
  return { agent, factor, strategy };
}
