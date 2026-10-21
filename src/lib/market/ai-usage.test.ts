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
    profileId: "default",
    pricePromptPerM: 2,
    priceCompletionPerM: 8,
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cost: 0.0036,
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

test("usageStats：总量直接求和，失败调用也计入，按模型分桶，费用按条目快照求和", () => {
  const entries = [
    entry({ model: "deepseek-chat", promptTokens: 1000, completionTokens: 200, totalTokens: 1200, ms: 800, ok: true, cost: 0.0036 }),
    entry({ model: "deepseek-chat", promptTokens: 500, completionTokens: 0, totalTokens: 500, ms: 1200, ok: false, layer: "strategy", cost: 0.001 }),
    entry({ model: "qwen3", promptTokens: 300, completionTokens: 100, totalTokens: 400, ms: 2000, ok: true, layer: "test", trigger: "test", pricePromptPerM: null, priceCompletionPerM: null, cost: 0 }),
  ];
  const s = usageStats(entries, "2026-10-09");
  assert.equal(s.totalCalls, 3);
  assert.equal(s.okCalls, 2);
  assert.equal(s.failCalls, 1);
  assert.equal(s.promptTokens, 1800);
  assert.equal(s.completionTokens, 300);
  assert.equal(s.totalTokens, 2100);
  assert.equal(s.totalMs, 4000);
  assert.equal(s.totalCost, 0.0046);
  assert.equal(s.pricedCalls, 2);
  assert.equal(s.byModel["deepseek-chat"].calls, 2);
  assert.equal(s.byModel["deepseek-chat"].tokens, 1700);
  assert.equal(s.byModel["deepseek-chat"].cost, 0.0046);
  assert.equal(s.byModel["qwen3"].cost, 0);
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

test("readAIUsage：费用功能之前的老条目缺新字段，读出来按缺省补齐不算 NaN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-usage-legacy-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    // 费用/档案快照功能上线前的原始条目形状：只有早期字段，没有
    // profileId / 价快照 / cost / error。直接写进账文件模拟旧账。
    const legacy = {
      at: "2026-10-09T01:15:00.000Z",
      layer: "factor",
      trigger: "manual",
      model: "deepseek-flash",
      promptTokens: 1234,
      completionTokens: 567,
      totalTokens: 1801,
      ms: 36588,
      ok: true,
    };
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ai-usage.json"), JSON.stringify({ entries: [legacy] }));
    const entries = await readAIUsage();
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.profileId, null);
    assert.equal(e.pricePromptPerM, null);
    assert.equal(e.priceCompletionPerM, null);
    assert.equal(e.cost, 0);
    assert.equal(e.error, undefined);
    assert.equal(e.ok, true);
    // 补齐后走统计聚合不能出 NaN。
    const s = usageStats(entries, "2026-10-09");
    assert.equal(s.totalCost, 0);
    assert.equal(Number.isNaN(s.totalCost), false);
    assert.equal(s.pricedCalls, 0);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("costOfTokens：分开计价、缺一记 0、 rounding 到分后 6 位", async () => {
  const { costOfTokens } = await import("@/lib/market/ai-usage");
  // 1M prompt @2元 + 500k completion @8元 = 2 + 4 = 6
  assert.equal(costOfTokens(1_000_000, 500_000, 2, 8), 6);
  // 缺 completion 价 → 只算 prompt
  assert.equal(costOfTokens(1_000_000, 500_000, 2, null), 2);
  // 都缺 → 0 不瞎编
  assert.equal(costOfTokens(1_000_000, 500_000, null, null), 0);
  // 小数千分位：1000 prompt @2元 = 0.002
  assert.equal(costOfTokens(1000, 0, 2, 8), 0.002);
});


// ── 历史估算（estCost，2026-10-21 起）────────────────────────────────────────
// 没单价快照的旧账按现行参考价补算，只展示、标注「估算」；有快照的永不重复估。

test("未计价条目按现价补估算；有快照的条目不重复估；两条口径互不污染", () => {
  const unpriced = entry({ pricePromptPerM: null, priceCompletionPerM: null, cost: 0, promptTokens: 1_000_000, completionTokens: 1_000_000, model: "deepseek-flash" });
  const priced = entry({ pricePromptPerM: 2, priceCompletionPerM: 8, cost: 0.0036, promptTokens: 1000, completionTokens: 200, model: "deepseek-chat" });
  const stats = usageStats([unpriced, priced], "2026-10-09", () => ({ prompt: 1.1, completion: 4.3 }));
  // 估算只算未计价那条：1M×1.1 + 1M×4.3 = 5.4 元
  assert.equal(stats.estCost, 5.4);
  assert.equal(stats.estCalls, 1);
  // 已计价口径只含有快照那条
  assert.equal(stats.totalCost, 0.0036);
  assert.equal(stats.pricedCalls, 1);
  assert.equal(stats.byModel["deepseek-flash"].estCost, 5.4);
  assert.equal(stats.byModel["deepseek-chat"].estCost, 0);
});

test("没给估算器（或查不到价）时 estCost 为 0——不瞎编分支", () => {
  const unpriced = entry({ pricePromptPerM: null, priceCompletionPerM: null, cost: 0 });
  const noResolver = usageStats([unpriced], "2026-10-09");
  assert.equal(noResolver.estCost, 0);
  assert.equal(noResolver.estCalls, 0);
  const missResolver = usageStats([unpriced], "2026-10-09", () => null);
  assert.equal(missResolver.estCost, 0);
  assert.equal(missResolver.estCalls, 0);
});
