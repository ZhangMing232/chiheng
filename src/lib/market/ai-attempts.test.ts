/**
 * AI 轮级尝试摘要 + 分层预算的纯函数测试。
 * 全部不碰网络/文件（IO 部分用临时目录，单独测）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyAIError, attemptStats, isSilentFallback,
  appendAIAttemptRound, readAIAttempts, AI_ATTEMPTS_CAP,
  type AIAttemptRound,
} from "@/lib/market/ai-attempts";
import { AI_ROUND_BUDGET_MS, AI_SINGLE_TIMEOUT_MS, nextAttemptTimeout } from "@/lib/market/factor-queue";

// ── 失败分类 ────────────────────────────────────────────────
test("错误分类：abort/超时归 timeout，别让「被掐掉」混进 other", () => {
  assert.equal(classifyAIError("This operation was aborted"), "timeout");
  assert.equal(classifyAIError("请求超时"), "timeout");
  assert.equal(classifyAIError("AI 接口 HTTP 429：rate limit"), "http429");
  assert.equal(classifyAIError("fetch failed"), "network");
  assert.equal(classifyAIError("AI 返回里没有内容"), "empty");
  assert.equal(classifyAIError("AI 接口 HTTP 400：bad"), "http");
  assert.equal(classifyAIError("别的什么"), "other");
});

// ── 分层预算：数据把「缩到 90s」推翻了 ──────────────────────
test("单次上限仍是 150s —— 90~145s 区间实测有 29 次成功，不能缩", () => {
  // 2026-11-06 ai-usage 实测：145s 以上 0 成功；90~120s 成功 19 次、
  // 120~145s 成功 10 次（factor 最长 144.1s）。把 factor 缩到 90s 会砍掉这些。
  assert.equal(AI_SINGLE_TIMEOUT_MS, 150_000);
  assert.ok(AI_ROUND_BUDGET_MS > AI_SINGLE_TIMEOUT_MS, "总预算要留得下第二个档案");
});

test("第二档案只拿剩余预算：主档案秒失败给满 150s，耗满 150s 只给 60s", () => {
  assert.equal(nextAttemptTimeout(AI_ROUND_BUDGET_MS, 10_000), 150_000, "429 秒失败，备用档案该有完整机会");
  assert.equal(nextAttemptTimeout(AI_ROUND_BUDGET_MS, 150_000), 60_000, "耗满一轮后不能再来 150s");
  assert.equal(nextAttemptTimeout(AI_ROUND_BUDGET_MS, 999_000), 30_000, "再超预算也有 30s 下限，不给 0/负数");
});

// ── 「成功但中途挂过」必须看得见 ────────────────────────────
const silentRound: AIAttemptRound = {
  at: "2026-11-06T00:00:00Z", layer: "factor", trigger: "auto", ms: 160_000, ok: true,
  attempts: [
    { index: 1, profileId: "default", timeoutMs: 150_000, ms: 150_000, ok: false, errorKind: "timeout", error: "This operation was aborted" },
    { index: 2, profileId: "moonshot-kimi", timeoutMs: 60_000, ms: 10_000, ok: true, errorKind: null },
  ],
  failed: 1, timedOut: 1, via: "direct",
};

test("fallback 成功后整轮 ok，但「中间超时过一次」要被认出来", () => {
  assert.equal(isSilentFallback(silentRound), true);
  assert.equal(isSilentFallback({ ...silentRound, failed: 0, timedOut: 0 }), false);
  assert.equal(isSilentFallback({ ...silentRound, ok: false }), false, "整轮失败不算隐性");
});

test("聚合：一轮成功、一次失败尝试、一次超时，别被 ok 洗掉", () => {
  const s = attemptStats([silentRound]);
  assert.deepEqual(s, { rounds: 1, okRounds: 1, silentFallbacks: 1, failedAttempts: 1, timedOut: 1, totalMs: 160_000 });
});

// ── 账本 IO ─────────────────────────────────────────────────
/** 必须 await：同步 finally 会在异步 IO 完成前就还原环境变量、删掉临时目录。 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-ai-attempts-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try { return await fn(dir); } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("轮级账本：追加后读得回，且不含任何 apiKey/密钥字段", async () => {
  await withTempDir(async (dir) => {
    await appendAIAttemptRound(silentRound);
    const rounds = await readAIAttempts();
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]!.timedOut, 1);
    assert.equal(rounds[0]!.attempts.length, 2);
    const raw = readFileSync(join(dir, "ai-attempts.json"), "utf8");
    assert.ok(!raw.includes("sk-"), "密钥不该进账本");
  });
});

test("轮级账本：坏文件当空账、超上限丢最旧，不让观测账本拖垮调用", async () => {
  await withTempDir(async (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ai-attempts.json"), "{坏掉的", "utf8");
    assert.deepEqual(await readAIAttempts(), []);
    // 造刚好超上限一轮的数据，追加后应被裁到 CAP
    const many = Array.from({ length: AI_ATTEMPTS_CAP }, (_, i) => ({ ...silentRound, at: `r${i}` }));
    writeFileSync(join(dir, "ai-attempts.json"), JSON.stringify({ rounds: many }), "utf8");
    await appendAIAttemptRound({ ...silentRound, at: "newest" });
    const rounds = await readAIAttempts();
    assert.equal(rounds.length, AI_ATTEMPTS_CAP);
    assert.equal(rounds.at(-1)!.at, "newest");
  });
});
