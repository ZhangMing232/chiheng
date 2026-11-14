/**
 * agent-jobs.ts 的纯函数测试：预算闸门 + 账本统计。
 * 全部不碰 fs——账本/配置的 IO 不在测试范围（同 ai-log.test.ts 的取舍）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gateJob,
  spentOnDay,
  spentInMonth,
  budgetExceeded,
  DEFAULT_BUDGET,
  type AgentJob,
} from "./agent-jobs.ts";

/** 造一条已完成的账目。 */
function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    at: "2026-11-14T03:00:00.000Z",
    task: "测试任务",
    trigger: "manual",
    budgetCny: 2,
    status: "ok",
    cost: { cny: 0.5, estimated: true },
    ...overrides,
  };
}

test("spentOnDay：只合计同一天的已完成条目", () => {
  const jobs = [
    job({ at: "2026-11-14T01:00:00Z", cost: { cny: 1, estimated: true } }),
    job({ at: "2026-11-13T01:00:00Z", cost: { cny: 3, estimated: true } }),
    job({ at: "2026-11-14T02:00:00Z", status: "running" }), // running 不计
    job({ at: "2026-11-14T03:00:00Z", cost: { cny: 0.5, estimated: true } }),
  ];
  assert.equal(spentOnDay(jobs, "2026-11-14"), 1.5);
  assert.equal(spentOnDay(jobs, "2026-11-13"), 3);
  assert.equal(spentOnDay([], "2026-11-14"), 0);
});

test("spentInMonth：按月合计，跨天归总", () => {
  const jobs = [
    job({ at: "2026-11-01T01:00:00Z", cost: { cny: 1, estimated: true } }),
    job({ at: "2026-11-20T01:00:00Z", cost: { cny: 2, estimated: true } }),
    job({ at: "2026-10-20T01:00:00Z", cost: { cny: 99, estimated: true } }),
  ];
  assert.equal(spentInMonth(jobs, "2026-11"), 3);
  assert.equal(spentInMonth(jobs, "2026-10"), 99);
});

test("gateJob：当日 + 本次 ≤ 日上限 → 放行", () => {
  const jobs = [job({ cost: { cny: 1, estimated: true } })];
  const v = gateJob(jobs, DEFAULT_BUDGET, 2, "2026-11-14", "2026-11");
  assert.equal(v.allowed, true);
});

test("gateJob：当日 + 本次 > 日上限 → 拒，理由带数字", () => {
  const jobs = [
    job({ cost: { cny: 4, estimated: true } }),
    job({ cost: { cny: 0.8, estimated: true } }),
  ]; // 今日已花 4.8
  const v = gateJob(jobs, DEFAULT_BUDGET, 2, "2026-11-14", "2026-11");
  assert.equal(v.allowed, false);
  assert.ok(!v.allowed && v.reason.includes("4.80"));
  assert.ok(!v.allowed && v.reason.includes("日上限"));
});

test("gateJob：日预算内但当月超 → 拒月闸", () => {
  const budget = { perTaskCny: 2, perDayCny: 5, perMonthCny: 10 };
  const jobs = [
    job({ at: "2026-11-10T01:00:00Z", cost: { cny: 6, estimated: true } }),
    job({ at: "2026-11-11T01:00:00Z", cost: { cny: 3, estimated: true } }),
  ]; // 本月 9，今天(11-14) 0
  const v = gateJob(jobs, budget, 2, "2026-11-14", "2026-11");
  assert.equal(v.allowed, false);
  assert.ok(!v.allowed && v.reason.includes("月上限"));
});

test("gateJob：浮点边界用 epsilon——正好卡线放行", () => {
  const budget = { perTaskCny: 2, perDayCny: 5, perMonthCny: 100 };
  const jobs = [job({ cost: { cny: 3, estimated: true } })];
  // 3 + 2 = 5 = 上限 → 放行
  const v = gateJob(jobs, budget, 2, "2026-11-14", "2026-11");
  assert.equal(v.allowed, true);
});

test("budgetExceeded：运行中且实际花费 > 单任务预算 → true", () => {
  const running = job({ status: "running", cost: { cny: 2.1, estimated: true } });
  assert.equal(budgetExceeded(running, DEFAULT_BUDGET), true);
  const within = job({ status: "running", cost: { cny: 1.9, estimated: true } });
  assert.equal(budgetExceeded(within, DEFAULT_BUDGET), false);
  const done = job({ cost: { cny: 99, estimated: true } }); // 已结束不判杀
  assert.equal(budgetExceeded(done, DEFAULT_BUDGET), false);
  const noCost = job({ status: "running" }); // 没回填花费 = 没超
  assert.equal(budgetExceeded(noCost, DEFAULT_BUDGET), false);
});

test("gateJob：空账本 + 0 预算任务也放行（闸门只看上限不是下限）", () => {
  const v = gateJob([], DEFAULT_BUDGET, 0.01, "2026-11-14", "2026-11");
  assert.equal(v.allowed, true);
});

// ── 总开关（IO，用 CHIHENG_DATA_DIR 指向临时目录实测读写）──
import { readMasterSwitch, writeMasterSwitch } from "./agent-jobs.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readMasterSwitch：没文件 = 默认开", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-sw-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    const sw = await readMasterSwitch();
    assert.equal(sw.enabled, true);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
  }
});

test("readMasterSwitch：写 off 读回 off，再写 on 读回 on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-sw-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await writeMasterSwitch(false);
    assert.equal((await readMasterSwitch()).enabled, false);
    await writeMasterSwitch(true);
    assert.equal((await readMasterSwitch()).enabled, true);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
  }
});
