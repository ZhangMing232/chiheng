/**
 * agent-schedules.ts 的测试：到点判定、工单状态机、顺手发现抽取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleDue,
  decideProposal,
  extractFindings,
  DEFAULT_SCHEDULES,
  type AgentSchedule,
  type AgentProposal,
} from "./agent-schedules.ts";

const sched = (o: Partial<AgentSchedule> = {}): AgentSchedule => ({
  id: "t1",
  task: "任务",
  hourLocal: 16,
  enabled: true,
  budgetCny: 1,
  ...o,
});

test("scheduleDue：开关关 = 永远不到点", () => {
  assert.equal(scheduleDue(sched({ enabled: false }), { day: "2026-11-14", hour: 20 }), false);
});

test("scheduleDue：当天跑过 = 不再跑（一天最多一次）", () => {
  assert.equal(scheduleDue(sched({ lastRunDay: "2026-11-14" }), { day: "2026-11-14", hour: 20 }), false);
});

test("scheduleDue：小时没到 = 不跑；到了 = 跑", () => {
  assert.equal(scheduleDue(sched({ hourLocal: 16 }), { day: "2026-11-14", hour: 15 }), false);
  assert.equal(scheduleDue(sched({ hourLocal: 16 }), { day: "2026-11-14", hour: 16 }), true);
  assert.equal(scheduleDue(sched({ hourLocal: 16 }), { day: "2026-11-14", hour: 23 }), true);
});

test("scheduleDue：昨天跑过今天还能跑", () => {
  assert.equal(scheduleDue(sched({ lastRunDay: "2026-11-13" }), { day: "2026-11-14", hour: 16 }), true);
});

test("默认清单：三条全关、预算都是 1 元（主人审过才开）", () => {
  assert.equal(DEFAULT_SCHEDULES.length, 3);
  for (const s of DEFAULT_SCHEDULES) {
    assert.equal(s.enabled, false, `${s.id} 默认必须是关的`);
    assert.equal(s.budgetCny, 1);
    assert.ok(s.task.length > 20);
  }
});

// ── 工单状态机 ──

const prop = (o: Partial<AgentProposal> = {}): AgentProposal => ({
  id: "p1",
  at: "2026-11-14T04:00:00Z",
  jobAt: "2026-11-14T03:00:00Z",
  finding: "发现问题",
  suggestion: "建议修法",
  status: "pending",
  ...o,
});

test("decideProposal：pending → approved，带决定时间", () => {
  const { list, changed } = decideProposal([prop()], "p1", "approved");
  assert.equal(changed, true);
  assert.equal(list[0].status, "approved");
  assert.ok(list[0].decidedAt);
});

test("decideProposal：已决定的不能再动", () => {
  const { list, changed } = decideProposal([prop({ status: "approved" })], "p1", "dismissed");
  assert.equal(changed, false);
  assert.equal(list[0].status, "approved");
});

test("decideProposal：id 对不上 = 没变化", () => {
  const { changed } = decideProposal([prop()], "nope", "approved");
  assert.equal(changed, false);
});

// ── 顺手发现抽取 ──

test("extractFindings：截取「顺手发现」段落", () => {
  const answer = "## 做了什么\n改了文件 A。\n\n顺手发现：genome 层 prompt 和校验器契约不一致，建议加自校验。";
  const got = extractFindings(answer);
  assert.ok(got.startsWith("顺手发现"));
  assert.ok(got.includes("genome"));
});

test("extractFindings：没有该段落 = 空串", () => {
  assert.equal(extractFindings("普通回答，没有发现。"), "");
});

test("extractFindings：段落截到下一个标题", () => {
  const answer = "顺手发现：问题一。\n## 另一节\n别的";
  assert.equal(extractFindings(answer), "顺手发现：问题一。");
});
