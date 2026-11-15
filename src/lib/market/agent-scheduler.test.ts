/**
 * agent-scheduler.ts 的测试：冷却判定 + tick 注入路径。
 * tickAgentSchedules 的 runTask 可注入，测试里传桩，不真 spawn headless。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickAgentSchedules, inCooldown } from "./agent-scheduler.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 临时数据目录（隔离真实 data/），用完还原。 */
async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sched-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("inCooldown：从未派过时 = false（lastDispatchAt=0 的初始状态）", () => {
  assert.equal(inCooldown(Date.now()), false);
});

test("total 开关 off：tick 空转，runTask 桩不该被调用", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-master-switch.json"), JSON.stringify({ enabled: false, at: "" }));
    let called = 0;
    const r = await tickAgentSchedules(new Date(), async () => {
      called++;
      return { ok: true, status: "ok", jobAt: new Date().toISOString() };
    });
    assert.equal(r.dispatched, null);
    assert.equal(r.checked, 0);
    assert.equal(called, 0);
  });
});

test("清单默认全关：无任何到点任务，runTask 桩不该被调用", async () => {
  await withTempDir(async () => {
    let called = 0;
    const r = await tickAgentSchedules(new Date(), async () => {
      called++;
      return { ok: true, status: "ok", jobAt: new Date().toISOString() };
    });
    assert.equal(r.dispatched, null);
    assert.equal(called, 0);
    assert.ok(r.skipped >= 3); // 三条默认任务全跳过
  });
});

test("一条 enabled 任务到点：一次 tick 只派一条，账本与清单回写", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-schedules.json"), JSON.stringify({
      schedules: [
        { id: "a", task: "任务A", hourLocal: 0, enabled: true, budgetCny: 1 },
        { id: "b", task: "任务B", hourLocal: 0, enabled: true, budgetCny: 1 },
      ],
    }));
    let calls = 0;
    const r = await tickAgentSchedules(new Date(), async () => {
      calls++;
      return { ok: true, status: "ok", cost: 0.05, answer: "桩回答", jobAt: new Date().toISOString() };
    });
    assert.equal(r.dispatched, "a");
    assert.equal(calls, 1, "一次 tick 只派一条（串行）");
    // 清单回写：a 有 lastRunDay，b 没有（留给下个 tick）
    const book = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "agent-schedules.json"), "utf8"));
    assert.equal(book.schedules[0].lastRunDay, new Date().toLocaleDateString("sv-SE"));
    assert.equal(book.schedules[0].lastStatus, "ok");
    assert.equal(book.schedules[1].lastRunDay, undefined);
  });
});

test("runTask 抛异常：不写 lastRunDay（留待下个 tick 重试）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "agent-schedules.json"), JSON.stringify({
      schedules: [{ id: "a", task: "任务A", hourLocal: 0, enabled: true, budgetCny: 1 }],
    }));
    await assert.rejects(
      tickAgentSchedules(new Date(), async () => { throw new Error("桩异常"); }),
      /桩异常/,
    );
    const book = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "agent-schedules.json"), "utf8"));
    assert.equal(book.schedules[0].lastRunDay, undefined, "失败不该消耗当天名额");
  });
});
