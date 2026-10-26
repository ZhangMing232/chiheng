/**
 * evolve-breaker 的测试。纯函数部分不碰 fs；IO 走 CHIHENG_DATA_DIR 临时目录。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_RETRY,
  BREAKER_RULE,
  autoLayerDue,
  initialBreakerState,
  isDoubleFailure,
  nextBreakerState,
  nextConsecutive,
  readBreaker,
  resetBreaker,
  writeBreaker,
} from "./evolve-breaker.ts";

const ok = { ok: true };
const fail = (error: string) => ({ ok: false, error });
const AT = "2026-10-10T07:00:00Z";

test("任一层成功就不算空转——半脑工作不该计败", () => {
  assert.equal(isDoubleFailure(ok, fail("策略层挂了")), false);
  assert.equal(isDoubleFailure(fail("因子层挂了"), ok), false);
  assert.equal(isDoubleFailure(fail("a"), fail("b")), true);
});

test("连续双败计数：成功清零，双败 +1", () => {
  let state = initialBreakerState();
  state = nextBreakerState(state, fail("a"), fail("b"), AT);
  assert.equal(state.consecutiveErrors, 1);
  state = nextBreakerState(state, ok, fail("b"), AT);
  assert.equal(state.consecutiveErrors, 0);
  assert.equal(state.trippedAt, null);
  state = nextBreakerState(state, fail("a"), fail("b"), AT);
  assert.equal(state.consecutiveErrors, 1);
});

test(`满 ${BREAKER_RULE.maxConsecutiveErrors} 轮双败熔断，原因带两层 error`, () => {
  let state = initialBreakerState();
  for (let i = 0; i < BREAKER_RULE.maxConsecutiveErrors; i += 1) {
    state = nextBreakerState(state, fail("API 欠费"), fail("prompt 不合规"), AT);
  }
  assert.equal(state.trippedAt, AT);
  assert.match(state.trippedReason, /API 欠费/);
  assert.match(state.trippedReason, /prompt 不合规/);
});

test("已熔断后状态不再推进——恢复不在函数里，在重新打开开关", () => {
  const tripped = { consecutiveErrors: 3, trippedAt: AT, trippedReason: "x" };
  const next = nextBreakerState(tripped, fail("a"), fail("b"), "2026-10-11T07:00:00Z");
  assert.equal(next, tripped);
});

test("nextConsecutive：纯计数不熔断", () => {
  const state = { consecutiveErrors: BREAKER_RULE.maxConsecutiveErrors - 1, trippedAt: null, trippedReason: "" };
  assert.equal(nextConsecutive(state, fail("a"), fail("b")), BREAKER_RULE.maxConsecutiveErrors);
  assert.equal(nextConsecutive(state, ok, ok), 0);
});

test("IO：写读回一致；坏文件 → 初始态；reset 清空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "breaker-"));
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.deepEqual(await readBreaker(), initialBreakerState());
    const tripped = { consecutiveErrors: 3, trippedAt: AT, trippedReason: "连续 3 轮两层都失败" };
    await writeBreaker(tripped);
    assert.deepEqual(await readBreaker(), tripped);
    await resetBreaker();
    assert.deepEqual(await readBreaker(), initialBreakerState());
  } finally {
    delete process.env.CHIHENG_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 失败补跑判据（autoLayerDue）─────────────────────────────
const T0 = Date.parse("2026-10-26T07:00:00Z");
const att = (layer: string, ok: boolean, at: string) => ({ layer, ok, at });

test("autoLayerDue：今天没跑过 → 该跑", () => {
  assert.equal(autoLayerDue([], "factor", T0), true);
});

test("autoLayerDue：今天已成功过 → 不再跑（ok 的轮次才算跑过）", () => {
  const attempts = [att("factor", true, "2026-10-26T06:00:00Z")];
  assert.equal(autoLayerDue(attempts, "factor", T0), false);
});

test("autoLayerDue：失败不算跑过——间隔够了就该补跑", () => {
  const attempts = [att("factor", false, "2026-10-26T06:00:00Z")];
  assert.equal(autoLayerDue(attempts, "factor", T0), true); // 距上次 1 小时 > 30 分钟
});

test("autoLayerDue：距上次失败不足最小间隔 → 不跑（防同分钟连打）", () => {
  const attempts = [att("factor", false, "2026-10-26T06:50:00Z")];
  assert.equal(autoLayerDue(attempts, "factor", T0), false); // 只有 10 分钟
});

test("autoLayerDue：尝试次数到上限 → 不跑（防整晚抽风每分钟重试）", () => {
  const attempts = [
    att("factor", false, "2026-10-26T06:00:00Z"),
    att("factor", false, "2026-10-26T06:31:00Z"),
    att("factor", false, "2026-10-26T07:02:00Z"),
  ];
  assert.equal(attempts.length, AUTO_RETRY.maxAttemptsPerDay);
  assert.equal(autoLayerDue(attempts, "factor", T0 + 60 * 60 * 1000), false);
});

test("autoLayerDue：只认自己这一层——策略层成败不影响因子层", () => {
  const attempts = [
    att("strategy", true, "2026-10-26T06:00:00Z"),
    att("agent", true, "2026-10-26T06:01:00Z"),
    att("factor", false, "2026-10-26T06:02:00Z"),
  ];
  assert.equal(autoLayerDue(attempts, "factor", T0), true);
  assert.equal(autoLayerDue(attempts, "strategy", T0), false);
});

test("autoLayerDue：一次成功后又有失败 → 仍以成功为准不再跑", () => {
  const attempts = [att("factor", false, "2026-10-26T06:00:00Z"), att("factor", true, "2026-10-26T06:31:00Z")];
  assert.equal(autoLayerDue(attempts, "factor", T0 + 60 * 60 * 1000), false);
});
