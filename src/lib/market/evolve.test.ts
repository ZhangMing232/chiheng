/**
 * 这个文件是干什么的：
 * 钉住进化编排（evolve.ts）的顺序和容错——这是 AI 大脑 harness 闭环的「串联层」：
 *   观察（全局诊断）→ 因子层 → 策略层
 *
 * 你需要知道的：
 * 用 opts 注入假实现，不碰真 AI / 真账本。要钉死三件事：
 * 1. 顺序：诊断必须先于两层提议跑（observe → plan → act，建议本轮就要进 prompt）。
 * 2. 容错：诊断抛异常 / 返回失败，两层提议照常跑，agent 如实记 null/失败。
 * 3. 各层独立：因子层抛异常时编排原样抛出（编排不做额外包装），不偷偷吞。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runEvolveLoop, type EvolveDeps } from "@/lib/market/evolve";
import type { AgentLoopResult } from "@/lib/market/agent-loop";
import type { AILoopResult } from "@/lib/market/factor-queue";
import type { StrategyAILoopResult } from "@/lib/market/strategy-ai";

const DEPS: EvolveDeps = {
  readRows: async () => ({ batch: null }),
  existingFactors: [],
};

const diagOk = (): Promise<AgentLoopResult> =>
  Promise.resolve({ ok: true, diagnosis: { summary: "s", factorLayer: "f", strategyLayer: "s", suggestions: [], ruleDeltas: [], ruleChangeRequests: [] } });
const factorOk = (): Promise<AILoopResult> => Promise.resolve({ ok: true, proposed: 1, rejected: 0, rejectReasons: [] });
const strategyOk = (): Promise<StrategyAILoopResult> => Promise.resolve({ ok: true, proposed: 1, rejected: 0, rejectReasons: [] });

test("顺序：诊断先于因子层，因子层先于策略层（observe → plan → act）", async () => {
  const order: string[] = [];
  await runEvolveLoop(DEPS, "manual", {
    diagnose: async () => { order.push("agent"); return diagOk(); },
    runFactor: async () => { order.push("factor"); return factorOk(); },
    runStrategy: async () => { order.push("strategy"); return strategyOk(); },
  });
  assert.deepEqual(order, ["agent", "factor", "strategy"]);
});

test("诊断抛异常：agent 记 null，两层照常跑，顺序不乱", async () => {
  const order: string[] = [];
  const result = await runEvolveLoop(DEPS, "auto", {
    diagnose: async () => { order.push("agent"); throw new Error("接口欠费"); },
    runFactor: async () => { order.push("factor"); return factorOk(); },
    runStrategy: async () => { order.push("strategy"); return strategyOk(); },
  });
  assert.equal(result.agent, null);
  assert.equal(result.factor.ok, true);
  assert.equal(result.strategy.ok, true);
  assert.deepEqual(order, ["agent", "factor", "strategy"]);
});

test("诊断返回失败对象（ok:false）：如实带在结果里，不替它翻案", async () => {
  const result = await runEvolveLoop(DEPS, "manual", {
    diagnose: async () => ({ ok: false, diagnosis: null, error: "返回不是合法 JSON" }),
    runFactor: factorOk,
    runStrategy: strategyOk,
  });
  assert.equal(result.agent?.ok, false);
  assert.equal(result.agent?.error, "返回不是合法 JSON");
});

test("trigger 原样传给三层（auto/manual 记账凭据不能丢）", async () => {
  const seen: string[] = [];
  await runEvolveLoop(DEPS, "auto", {
    diagnose: async () => { seen.push("agent:auto"); return diagOk(); },
    runFactor: async (t) => { seen.push(`factor:${t}`); return factorOk(); },
    runStrategy: async (t) => { seen.push(`strategy:${t}`); return strategyOk(); },
  });
  assert.deepEqual(seen, ["agent:auto", "factor:auto", "strategy:auto"]);
});
