/**
 * factor-tombstones 的测试。纯函数部分（diff/build）不碰 fs；
 * 文件 IO 走 CHIHENG_DATA_DIR 指到临时目录。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { QueueEntry } from "./factor-queue.ts";
import {
  appendTombstones,
  buildRecord,
  diffTombstones,
  readTombstones,
  type TombstoneRecord,
} from "./factor-tombstones.ts";

function entry(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    id: "test-factor",
    name: "测试因子",
    category: "反转",
    direction: -1,
    expr: "std20",
    rationale: "低波动异象",
    source: "ai",
    status: "tested",
    failCount: 1,
    runs: 2,
    createdAt: "2026-10-01T00:00:00Z",
    lastRunAt: "2026-10-09T00:00:00Z",
    ...overrides,
  };
}

test("diffTombstones：只挑这一轮新死的，一直死着的和没死的不算", () => {
  const before = [
    entry({ id: "a", status: "tested", failCount: 1 }),
    entry({ id: "b", status: "tombstone" }), // 上一轮就死了
    entry({ id: "c", status: "passed" }),
  ];
  const after = [
    entry({ id: "a", status: "tombstone", failCount: 2, note: "连续 2 次未过 6 关，自动淘汰" }),
    entry({ id: "b", status: "tombstone" }),
    entry({ id: "c", status: "decayed" }), // decayed 是停跑不是死，不进档案
  ];
  const died = diffTombstones(before, after);
  assert.deepEqual(died.map((e) => e.id), ["a"]);
});

test("buildRecord：败关进档案；没有判决也能归档（死因记空，不编）", () => {
  const dead = entry({ id: "a", status: "tombstone", failCount: 2, expr: "std20 / amp20" });
  const withVerdict = buildRecord(dead, { id: "a", passed: false, at: "2026-10-10T07:00:00Z", failedGates: ["g1", "g3"] });
  assert.equal(withVerdict.failedGates.join(","), "g1,g3");
  assert.equal(withVerdict.diedAt, "2026-10-10T07:00:00Z");
  assert.equal(withVerdict.runs, 2);
  assert.equal(withVerdict.expr, "std20 / amp20");

  const noVerdict = buildRecord(dead, undefined);
  assert.deepEqual(noVerdict.failedGates, []);
});

test("buildRecord：衰减退役（verdict 无败关）和 6 关淘汰在档案里分得开", () => {
  const dead = entry({ id: "a", status: "tombstone" });
  const decayed = buildRecord(dead, { id: "a", passed: true, at: "2026-10-10T07:00:00Z" });
  assert.deepEqual(decayed.failedGates, []);
  const killed = buildRecord(dead, { id: "a", passed: false, at: "2026-10-10T07:00:00Z", failedGates: ["g2"] });
  assert.deepEqual(killed.failedGates, ["g2"]);
});

test("append/read：追加两条、读回两条，只追加不改", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tombstones-"));
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    const dead = entry({ id: "a", status: "tombstone" });
    const r1 = buildRecord(dead, { id: "a", passed: false, at: "2026-10-10T07:00:00Z", failedGates: ["g1"] });
    const r2 = buildRecord(entry({ id: "b", status: "tombstone", source: "manual" }), undefined);
    await appendTombstones([r1]);
    await appendTombstones([r2]); // 第二次追加不能覆盖第一次
    const all = await readTombstones();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, "a");
    assert.equal(all[1].id, "b");
    assert.equal(all[1].source, "manual");
  } finally {
    delete process.env.CHIHENG_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("read：文件不存在 → 空数组，不抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tombstones-empty-"));
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.deepEqual(await readTombstones(), []);
  } finally {
    delete process.env.CHIHENG_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// 类型兜底：档案字段改动时这里会提醒同步测试。
const _shape: TombstoneRecord = buildRecord(entry({}), undefined);
void _shape;
