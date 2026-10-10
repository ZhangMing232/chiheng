/** decision-ledger 的测试：buildLedger 纯函数喂构造数据。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLedger } from "./decision-ledger.ts";
import type { QueueEntry } from "./factor-queue.ts";
import type { Challenger } from "./challenger.ts";
import type { TombstoneRecord } from "./factor-tombstones.ts";

function q(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    id: "x",
    name: "x",
    category: "反转",
    direction: -1,
    expr: "std20",
    rationale: "r",
    source: "ai",
    status: "pending",
    failCount: 0,
    runs: 0,
    createdAt: "t",
    lastRunAt: null,
    ...overrides,
  };
}

function c(overrides: Partial<Challenger>): Challenger {
  return { id: "c1", style: "rebound", name: "x", status: "running", since: "2026-10-01", ...overrides };
}

function t(overrides: Partial<TombstoneRecord>): TombstoneRecord {
  return {
    id: "x",
    name: "x",
    category: "反转",
    direction: -1,
    source: "ai",
    diedAt: "t",
    runs: 2,
    failCount: 2,
    note: "",
    failedGates: ["g1"],
    rationale: "r",
    expr: "e",
    ...overrides,
  };
}

test("空账：全部 0，不 NaN", () => {
  const L = buildLedger({ queue: [], challengers: [], tombstones: [] });
  assert.deepEqual(L.factors.ai, { proposed: 0, passed: 0, pending: 0, dead: 0 });
  assert.deepEqual(L.challengers.manual, { proposed: 0, running: 0, promoted: 0, rejected: 0, inconclusive: 0 });
});

test("因子层按 source 分账：passed/monitoring 算过关，decayed 算死", () => {
  const L = buildLedger({
    queue: [
      q({ id: "a1", source: "ai", status: "passed" }),
      q({ id: "a2", source: "ai", status: "monitoring" }),
      q({ id: "a3", source: "ai", status: "pending" }),
      q({ id: "a4", source: "ai", status: "decayed" }),
      q({ id: "m1", source: "manual", status: "tombstone" }),
    ],
    challengers: [],
    tombstones: [],
  });
  assert.deepEqual(L.factors.ai, { proposed: 4, passed: 2, pending: 1, dead: 1 });
  assert.deepEqual(L.factors.manual, { proposed: 1, passed: 0, pending: 0, dead: 1 });
});

test("挑战者没标 source 的归 manual——和 challenger.ts 的注释同一约定", () => {
  const L = buildLedger({
    queue: [],
    challengers: [
      c({ id: "c1", status: "promoted" }),
      c({ id: "c2", source: "ai", status: "rejected" }),
      c({ id: "c3", source: "ai", status: "running" }),
    ],
    tombstones: [],
  });
  assert.deepEqual(L.challengers.manual, { proposed: 1, running: 0, promoted: 1, rejected: 0, inconclusive: 0 });
  assert.deepEqual(L.challengers.ai, { proposed: 2, running: 1, promoted: 0, rejected: 1, inconclusive: 0 });
});

test("死因档案按 source 计数", () => {
  const L = buildLedger({
    queue: [],
    challengers: [],
    tombstones: [t({ id: "a" }), t({ id: "b" }), t({ id: "c", source: "manual" })],
  });
  assert.equal(L.tombstones.ai, 2);
  assert.equal(L.tombstones.manual, 1);
});
