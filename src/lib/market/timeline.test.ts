/**
 * timeline.ts 的测试：两本账 → 一条时间线的映射。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, spentOn, type TimelineItem } from "./timeline.ts";
import type { AILogEntry } from "./ai-log.ts";
import type { AgentJob } from "./agent-jobs.ts";
import type { AIUsageEntry } from "./ai-usage.ts";

const routine = (o: Partial<AILogEntry>): AILogEntry => ({
  at: "2026-11-13T07:06:00Z",
  layer: "factor",
  trigger: "auto",
  ok: true,
  proposed: [],
  rejected: [],
  ...o,
});

const job = (o: Partial<AgentJob>): AgentJob => ({
  at: "2026-11-14T04:00:00Z",
  task: "检查挑战者",
  trigger: "manual",
  budgetCny: 2,
  status: "ok",
  ...o,
});

const usage = (o: Partial<AIUsageEntry>): AIUsageEntry => ({
  at: "2026-11-13T07:03:00Z",
  layer: "agent",
  trigger: "auto",
  model: "deepseek-v4-pro",
  profileId: null,
  pricePromptPerM: 4.7,
  priceCompletionPerM: 14.1,
  promptTokens: 1000,
  completionTokens: 1000,
  totalTokens: 2000,
  cost: 0.02,
  ms: 3000,
  ok: true,
  ...o,
});

test("混排：例行和派活按时间倒序合成一条流水", () => {
  const tl = buildTimeline(
    [routine({ at: "2026-11-13T07:06:00Z" })],
    [job({ at: "2026-11-14T04:00:00Z" })],
    [],
  );
  assert.equal(tl.length, 2);
  assert.equal(tl[0].source, "manual"); // 新的在前
  assert.equal(tl[1].source, "routine");
});

test("例行摘要：层名 + 进/拒计数 + 空转标注", () => {
  const tl = buildTimeline([
    routine({ layer: "strategy", proposed: [], rejected: [] }),
    routine({ layer: "factor", proposed: [{ id: "a", name: "甲" }], rejected: ["理由一", "理由二"] }),
  ], [], []);
  const strategy = tl.find((t) => t.title.includes("策略层"))!;
  assert.ok(strategy.title.includes("空转"), "全空要标合理空转");
  const factor = tl.find((t) => t.title.includes("因子层"))!;
  assert.ok(factor.title.includes("进 1"), factor.title);
  assert.ok(factor.title.includes("拒 2"));
  assert.equal(factor.detail, "理由一；理由二");
});

test("例行失败条目：ok=false → status=error，detail 用 error", () => {
  const tl = buildTimeline([routine({ ok: false, error: "接口超时" })], [], []);
  assert.equal(tl[0].status, "error");
  assert.equal(tl[0].detail, "接口超时");
});

test("例行花费回填：usage 落在两条例行之间的调用归前一条", () => {
  // agent 07:00 开跑 → 调用 07:03 → factor 07:06 开跑。07:03 的花费归 agent 条目。
  const tl = buildTimeline(
    [
      routine({ at: "2026-11-13T07:00:00Z", layer: "agent" }),
      routine({ at: "2026-11-13T07:06:00Z", layer: "factor" }),
    ],
    [],
    [usage({ at: "2026-11-13T07:03:00Z", cost: 0.52 })],
  );
  const agent = tl.find((t) => t.kind.includes("诊断"))!;
  assert.equal(agent.costCny, 0.52);
  const factor = tl.find((t) => t.kind.includes("因子层"))!;
  assert.equal(factor.costCny, 0); // factor 自己没有调用，0（真实计算结果非 null）
});

test("派活条目：花费自用，running 不算进已花", () => {
  const tl = buildTimeline([], [job({ cost: { cny: 0.15, estimated: true } })], []);
  assert.equal(tl[0].costCny, 0.15);
  const running = buildTimeline([], [job({ status: "running" })], []);
  assert.equal(running[0].detail, "进行中…");
});

test("limit 截断：取最新的 N 条", () => {
  const jobs: AgentJob[] = Array.from({ length: 60 }, (_, i) =>
    job({ at: `2026-11-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`, task: `任务${i}` }),
  );
  const tl = buildTimeline([], jobs, [], 50);
  assert.equal(tl.length, 50);
});

test("spentOn：同日已完成条目的花费合计", () => {
  const tl = buildTimeline(
    [],
    [
      job({ at: "2026-11-14T01:00:00Z", cost: { cny: 0.2, estimated: true } }),
      job({ at: "2026-11-14T02:00:00Z", cost: { cny: 0.3, estimated: true } }),
      job({ at: "2026-11-14T03:00:00Z", status: "running" }),
      job({ at: "2026-11-13T01:00:00Z", cost: { cny: 9, estimated: true } }),
    ],
    [],
  );
  assert.equal(spentOn(tl, "2026-11-14"), 0.5);
});
