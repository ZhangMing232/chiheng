/**
 * eastmoney-fetch.ts 的测试：纯函数重试判定 / 健康状态机 / 包装器（fetch 桩）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRetry, healthAfter, isDegraded, readEmHealth, recordEmOutcome, eastmoneyFetch, type EmHealth } from "./eastmoney-fetch.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shouldRetry：5xx / 429 重试，4xx / 2xx 不重试", () => {
  assert.equal(shouldRetry(500), true);
  assert.equal(shouldRetry(502), true);
  assert.equal(shouldRetry(429), true);
  assert.equal(shouldRetry(403), false);
  assert.equal(shouldRetry(404), false);
  assert.equal(shouldRetry(200), false);
});

const clean = { consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null, lastError: null };

test("healthAfter：失败累加、成功清零", () => {
  const a = healthAfter(clean, false, "2026-11-15T01:00:00Z", "HTTP 500");
  assert.equal(a.consecutiveFailures, 1);
  assert.equal(a.lastError, "HTTP 500");
  const b = healthAfter(a, false, "2026-11-15T01:01:00Z", "timeout");
  assert.equal(b.consecutiveFailures, 2);
  const c = healthAfter(b, true, "2026-11-15T01:02:00Z");
  assert.equal(c.consecutiveFailures, 0);
  assert.equal(c.lastError, null);
  assert.equal(c.lastSuccessAt, "2026-11-15T01:02:00Z");
});

test("isDegraded：连续 3 次失败才降级（一次抖动不误报）", () => {
  assert.equal(isDegraded(null), false);
  assert.equal(isDegraded(healthAfter(clean, false, "x")), false);
  let h: EmHealth = clean;
  h = healthAfter(h, false, "x");
  h = healthAfter(h, false, "x");
  assert.equal(isDegraded(h), false);
  h = healthAfter(h, false, "x");
  assert.equal(isDegraded(h), true);
});

test("readEmHealth：没文件 = null（不编）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.equal(await readEmHealth(), null);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordEmOutcome：两次失败后读回计数 2，成功归零", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await recordEmOutcome(false, "HTTP 500");
    await recordEmOutcome(false, "timeout");
    assert.equal((await readEmHealth())?.consecutiveFailures, 2);
    await recordEmOutcome(true);
    assert.equal((await readEmHealth())?.consecutiveFailures, 0);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("eastmoneyFetch：第一次成功直接返回，不重试", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    let calls = 0;
    const stub = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const r = await eastmoneyFetch("https://example.test/x", { fetchImpl: stub, retries: 2, backoffMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("eastmoneyFetch：500 会退避重试，重试成功算成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    let calls = 0;
    const stub = (async () => {
      calls++;
      return new Response(calls === 1 ? "err" : "{}", { status: calls === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const r = await eastmoneyFetch("https://example.test/x", { fetchImpl: stub, retries: 1, backoffMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(calls, 2);
    assert.equal((await readEmHealth())?.consecutiveFailures, 0);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("eastmoneyFetch：一直 403 不重试，失败落账", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    let calls = 0;
    const stub = (async () => { calls++; return new Response("denied", { status: 403 }); }) as unknown as typeof fetch;
    const r = await eastmoneyFetch("https://example.test/x", { fetchImpl: stub, retries: 2, backoffMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(calls, 1, "4xx 不该重试");
    assert.equal((await readEmHealth())?.consecutiveFailures, 1);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("eastmoneyFetch：网络异常重试后仍失败，错误原因保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "em-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    const stub = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    const r = await eastmoneyFetch("https://example.test/x", { fetchImpl: stub, retries: 1, backoffMs: 0 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.includes("socket hang up"));
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
