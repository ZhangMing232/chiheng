/**
 * agent-charter.ts 的测试：守则常量 + 系统 prompt 组装。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentSystemPrompt,
  AGENT_CHARTER,
  FALLBACK_FACTS,
  AGENT_DEFAULT_TASK_BUDGET_CNY,
  type AgentProjectFacts,
} from "./agent-charter.ts";

test("守则包含全部铁律关键词", () => {
  for (const kw of ["降序", "|t| >= 2", "提议权", "写死", "missing", "1:1", "stamp"]) {
    assert.ok(AGENT_CHARTER.includes(kw), `守则缺关键词：${kw}`);
  }
});

test("守则标明不可碰的红线", () => {
  assert.ok(AGENT_CHARTER.includes("真实券商"));
  assert.ok(AGENT_CHARTER.includes("模拟盘"));
});

test("FALLBACK_FACTS：未知就写未知，不编数", () => {
  assert.equal(FALLBACK_FACTS.gitHead, "未知");
  assert.equal(FALLBACK_FACTS.testCount, null);
});

test("buildAgentSystemPrompt：守则 + 全部事实都进 prompt", () => {
  const facts: AgentProjectFacts = {
    gitHead: "651bb66",
    gitClean: false,
    dirtyCount: 3,
    testCount: 1409,
    breakerTripped: true,
    breakerReason: "连续 3 轮失败",
    recentNote: "因子层提议 2 个",
  };
  const prompt = buildAgentSystemPrompt(facts);
  assert.ok(prompt.includes("651bb66"));
  assert.ok(prompt.includes("1409"));
  assert.ok(prompt.includes("已触发"));
  assert.ok(prompt.includes("连续 3 轮失败"));
  assert.ok(prompt.includes("因子层提议 2 个"));
  assert.ok(prompt.includes("3 个文件"));
  assert.ok(prompt.startsWith("你是「小机」"));
});

test("buildAgentSystemPrompt：兜底事实也能组装（不抛错）", () => {
  const prompt = buildAgentSystemPrompt(FALLBACK_FACTS);
  assert.ok(prompt.includes("未知"));
  assert.ok(prompt.includes("正常")); // 熔断器兜底按正常算
});

test("默认单任务预算是正数", () => {
  assert.ok(AGENT_DEFAULT_TASK_BUDGET_CNY > 0);
});
