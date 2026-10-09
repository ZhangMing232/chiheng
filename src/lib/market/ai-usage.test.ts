/**
 * 这个文件是干什么的：
 * 钉住 AI token 用量账（ai-usage.ts）的约定——读写/封顶、统计聚合（按模型分桶、
 * 近 7 天趋势）、失败调用也计入（烧了 prompt token 就是烧了）。
 *
 * 为什么值得钉：
 * 1. 监控台的数字是计费依据的近似，错一个口径（比如漏算失败调用的 token）
 *    用户对着账查会觉得系统偷烧了他的额度。
 * 2. 7 天趋势窗口必须含今天、按日历日对齐，不能滑成「最近 168 小时」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_USAGE_CAP, readAIUsage, appendAIUsage, usageStats, type AIUsageEntry } from "@/lib/market/ai-usage";

function entry(partial: Partial<AIUsageEntry> = {}): AIUsageEntry {
  return {
    at: "2026-10-09T10:00:00.000Z",
    layer: "factor",
    trigger: "manual",
    model: "deepseek-chat",
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    ms: 800,
    ok: true,
    ...partial,
  };
}

test("用量账读写往返；不存在返回空数组；写爆封顶丢最旧的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-usage-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.deepEqual(await readAIUsage(), []);
    await appendAIUsage(entry());
    assert.equal((await readAIUsage()).length, 1);
    for (let i = 0; i < AI_USAGE_CAP + 5; i++) await appendAIUsage(entry({ at: `2026-10-09T10:${String(i % 60).padStart(2, "0")}:00.000Z` }));
    const entries = await readAIUsage();
    assert.equal(entries.length, AI_USAGE_CAP);
    assert.match(entries[0].at, /:05:/);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("usageStats：总量直接求和，失败调用也计入，按模型分桶", () => {
  const entries = [
    entry({ model: "deepseek-chat", promptTokens: 1000, completionTokens: 200, totalTokens: 1200, ms: 800, ok: true }),
    entry({ model: "deepseek-chat", promptTokens: 500, completionTokens: 0, totalTokens: 500, ms: 1200, ok: false, layer: "strategy" }),
    entry({ model: "qwen3", promptTokens: 300, completionTokens: 100, totalTokens: 400, ms: 2000, ok: true, layer: "test", trigger: "test" }),
  ];
  const s = usageStats(entries, "2026-10-09");
  assert.equal(s.totalCalls, 3);
  assert.equal(s.okCalls, 2);
  assert.equal(s.failCalls, 1);
  assert.equal(s.promptTokens, 1800);
  assert.equal(s.completionTokens, 300);
  assert.equal(s.totalTokens, 2100);
  assert.equal(s.totalMs, 4000);
  assert.equal(s.byModel["deepseek-chat"].calls, 2);
  assert.equal(s.byModel["deepseek-chat"].tokens, 1700);
  assert.equal(s.byModel["deepseek-chat"].ok, 1);
  assert.equal(s.byModel["qwen3"].ms, 2000);
});

test("usageStats：近 7 天含今天，窗口外的记录不进趋势", () => {
  const today = "2026-10-09";
  const entries = [
    entry({ at: "2026-10-09T08:00:00.000Z", totalTokens: 100 }), // 今天
    entry({ at: "2026-10-03T08:00:00.000Z", totalTokens: 200 }), // 7 天前（含）
    entry({ at: "2026-10-02T23:59:59.000Z", totalTokens: 999 }), // 窗口外
  ];
  const s = usageStats(entries, today);
  assert.equal(s.last7Days.length, 7);
  assert.equal(s.last7Days[0].date, "2026-10-03");
  assert.equal(s.last7Days[0].tokens, 200);
  assert.equal(s.last7Days[6].date, "2026-10-09");
  assert.equal(s.last7Days[6].tokens, 100);
  assert.ok(s.last7Days.every((d) => d.date !== "2026-10-02"));
});
