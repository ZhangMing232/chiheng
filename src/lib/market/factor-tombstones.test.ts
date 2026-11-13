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
  describeDeath,
  liveDeaths,
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

test("liveDeaths：复活的因子（队列里已 passed）不再算死因", () => {
  // 2026-11-05：因子换把尺子（样本池 300→1200）重考后，有 20 个因子在新尺子下
  // 过了核心 4 关、队列状态回到 passed。档案是纯追加的历史，但喂给 AI 的死因档案
  // 里不能还留着活着的因子——AI 会因此去避开已经活着的因子。
  const records = [
    { id: "dead_one", name: "还死着的" },
    { id: "alive_one", name: "复活的" },
  ] as unknown as TombstoneRecord[];
  const queue = [
    { id: "alive_one", status: "passed" },
    { id: "dead_one", status: "tombstone" },
  ];
  const live = liveDeaths(records, queue);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.id, "dead_one");
});

test("liveDeaths：队列里没有的（比如手工登记的老因子）照旧算死因", () => {
  const records = [{ id: "x", name: "老因子" }] as unknown as TombstoneRecord[];
  assert.equal(liveDeaths(records, []).length, 1);
});

// ── 死因描述（2026-11-14）──────────────────────────────────────────
// 实测问题：94 条墓碑的 note 全是「连续 2 次未过 6 关，自动淘汰」，
// 一模一样，AI 从死因档案里学不到「为什么死」。下面把死因分三档说清。

test("🔴 五关全挂 → 明说因子本身有问题，别提近亲变体", () => {
  const s = describeDeath({ failCount: 2 }, ["g1", "g2", "g3", "g4", "g5"]);
  assert.match(s, /五关全挂/);
  assert.match(s, /换方向/);
  assert.match(s, /不是「差一点」/);
});

test("🔴 挂 g5 且多关 → 点明「试多了碰巧显著」", () => {
  const s = describeDeath({ failCount: 2 }, ["g2", "g3", "g5"]);
  assert.match(s, /多重检验/);
  assert.match(s, /别当信号用/);
});

test("只挂一两关 → 说接近可用，值得再试", () => {
  const s = describeDeath({ failCount: 2 }, ["g3"]);
  assert.match(s, /接近可用/);
  assert.match(s, /值得换参数/);
});

test("关卡名翻成中文，不甩 g1/g2 给用户", () => {
  const s = describeDeath({ failCount: 2 }, ["g2", "g5"]);
  assert.match(s, /信噪比/);
  assert.match(s, /多重检验/);
  assert.ok(!/g2|g5/.test(s), "不该把内部 key 露出来");
});

test("没记录关卡时如实说，不编", () => {
  const s = describeDeath({ failCount: 2 }, []);
  assert.match(s, /未记录具体关卡/);
});

test("buildRecord 用真实死因，不再抄那句固定文案", () => {
  const entry = { id: "x", name: "X", category: "动量", direction: 1, source: "ai", runs: 2, failCount: 2,
    note: "连续 2 次未过 6 关，自动淘汰", rationale: "r", expr: "e" } as never;
  const rec = buildRecord(entry, { at: "2026-11-14T00:00:00Z", failedGates: ["g1", "g2", "g3", "g4", "g5"] } as never);
  assert.match(rec.note, /五关全挂/);
  assert.deepEqual(rec.failedGates, ["g1", "g2", "g3", "g4", "g5"]);
});
