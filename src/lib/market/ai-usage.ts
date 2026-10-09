/**
 * 这个文件是干什么的：
 * AI token 用量账本（data/ai-usage.json）。每次调 AI 接口（因子闭环 / 策略闭环 /
 * 连通性测试）都把响应里的 usage 字段记下来：prompt / completion / total tokens、
 * 耗时、成败、用的哪套模型。/ai 页的「Token 用量监控」区块从这里出统计。
 *
 * 你需要知道的：
 * 1. 记录发生在 callAI（factor-queue.ts）内部——所有调用都逃不掉这张账，
 *    新增调用方不用记得手动记。
 * 2. 有些接口不返回 usage（字段缺失），记 0 不瞎编；估算列只展示真实报数。
 * 3. **不算钱**：各家的计价不同且常变，展示 token 数，单价你自己乘。
 * 4. 账本最多 2000 条，满了丢最旧的；data/ 在 .gitignore 里。
 * 5. 纯函数（统计聚合）不依赖 fs，直接单测。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── 数据结构 ────────────────────────────────────────────────────

export type AIUsageEntry = {
  at: string;
  /** 哪条链路调的：factor（因子闭环）/ strategy（策略闭环）/ test（连通性测试）。 */
  layer: string;
  trigger: "manual" | "auto" | "test";
  model: string;
  /** 调用时启用的档案（计价钱包的来源）。 */
  profileId: string | null;
  /** 调用时的单价快照（元/百万 tokens）：null = 当时没填价，费用记 0 不瞎编。 */
  pricePromptPerM: number | null;
  priceCompletionPerM: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 本次调用的费用（元），调用时按快照算好；没有价 = 0。 */
  cost: number;
  ms: number;
  ok: boolean;
  /** 失败原因（HTTP 状态 + 接口返回的前 200 字），成功的调用不记。 */
  error?: string;
};

/** 账本上限，满了丢最旧的。比 ai-log 大：用量是流水账，轮次账是事件账。 */
export const AI_USAGE_CAP = 2000;

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const aiUsagePath = () => join(dataDir(), "ai-usage.json");

/** 读用量账。文件不存在或坏了 → 空数组，绝不抛错。
 *  老条目缺后加的字段（profileId/价快照/cost/error）时按缺省补齐——账本是
 *  追加式的，新字段不能让旧账读崩或页面算出 NaN。 */
export async function readAIUsage(): Promise<AIUsageEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(aiUsagePath(), "utf8")) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return (parsed.entries as Partial<AIUsageEntry>[]).map((e) => ({
      at: typeof e.at === "string" ? e.at : "",
      layer: typeof e.layer === "string" ? e.layer : "unknown",
      trigger: e.trigger === "auto" || e.trigger === "test" ? e.trigger : "manual",
      model: typeof e.model === "string" ? e.model : "unknown",
      profileId: typeof e.profileId === "string" ? e.profileId : null,
      pricePromptPerM: typeof e.pricePromptPerM === "number" ? e.pricePromptPerM : null,
      priceCompletionPerM: typeof e.priceCompletionPerM === "number" ? e.priceCompletionPerM : null,
      promptTokens: typeof e.promptTokens === "number" ? e.promptTokens : 0,
      completionTokens: typeof e.completionTokens === "number" ? e.completionTokens : 0,
      totalTokens: typeof e.totalTokens === "number" ? e.totalTokens : 0,
      cost: typeof e.cost === "number" ? e.cost : 0,
      ms: typeof e.ms === "number" ? e.ms : 0,
      ok: e.ok === true,
      error: typeof e.error === "string" ? e.error : undefined,
    }));
  } catch {
    return [];
  }
}

/** 追加一条。写失败不抛错——记账失败不该把调用本身炸掉。 */
export async function appendAIUsage(entry: AIUsageEntry): Promise<void> {
  try {
    const entries = [...(await readAIUsage()), entry];
    const trimmed = entries.length > AI_USAGE_CAP ? entries.slice(entries.length - AI_USAGE_CAP) : entries;
    await mkdir(dataDir(), { recursive: true });
    await writeFile(aiUsagePath(), JSON.stringify({ entries: trimmed }, null, 2));
  } catch (error) {
    console.error("ai-usage 写入失败（不影响调用结果）:", (error as Error).message);
  }
}

/** 按价算钱（元）：prompt/completion 分开计价（元/百万 tokens），任一缺价就记 0 不瞎编。 */
export function costOfTokens(
  promptTokens: number,
  completionTokens: number,
  pricePromptPerM: number | null,
  priceCompletionPerM: number | null,
): number {
  const prompt = pricePromptPerM != null ? (promptTokens / 1_000_000) * pricePromptPerM : 0;
  const completion = priceCompletionPerM != null ? (completionTokens / 1_000_000) * priceCompletionPerM : 0;
  return Math.round((prompt + completion) * 1e6) / 1e6;
}

// ── 纯函数：统计聚合 ────────────────────────────────────────────

export type UsageStats = {
  totalCalls: number;
  okCalls: number;
  failCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalMs: number;
  /** 总费用（元）：各条目调用时按当时价快照算好的求和。 */
  totalCost: number;
  /** 有费用记录的条目数（没填价的调用不进均价）。 */
  pricedCalls: number;
  /** 按模型分桶：调用数 + token 数 + 费用。 */
  byModel: Record<string, { calls: number; ok: number; tokens: number; ms: number; cost: number }>;
  /** 最近 7 天（含今天）每天的 token + 费用汇总，给趋势用。 */
  last7Days: { date: string; tokens: number; calls: number; cost: number }[];
};

/** 从用量账算统计。数字全是直接求和，不加工；不过滤失败调用（失败的调用也烧了 prompt token）。 */
export function usageStats(entries: AIUsageEntry[], today: string): UsageStats {
  const stats: UsageStats = {
    totalCalls: entries.length,
    okCalls: entries.filter((e) => e.ok).length,
    failCalls: entries.filter((e) => !e.ok).length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalMs: 0,
    totalCost: 0,
    pricedCalls: 0,
    byModel: {},
    last7Days: [],
  };
  for (const e of entries) {
    stats.promptTokens += e.promptTokens;
    stats.completionTokens += e.completionTokens;
    stats.totalTokens += e.totalTokens;
    stats.totalMs += e.ms;
    stats.totalCost += e.cost;
    if (e.pricePromptPerM != null || e.priceCompletionPerM != null) stats.pricedCalls += 1;
    const bucket = (stats.byModel[e.model] ??= { calls: 0, ok: 0, tokens: 0, ms: 0, cost: 0 });
    bucket.calls += 1;
    if (e.ok) bucket.ok += 1;
    bucket.tokens += e.totalTokens;
    bucket.ms += e.ms;
    bucket.cost += e.cost;
  }
  const days: { date: string; tokens: number; calls: number; cost: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    days.push({ date: shiftDate(today, -i), tokens: 0, calls: 0, cost: 0 });
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const e of entries) {
    const day = byDate.get(e.at.slice(0, 10));
    if (!day) continue;
    day.tokens += e.totalTokens;
    day.calls += 1;
    day.cost += e.cost;
  }
  stats.last7Days = days;
  return stats;
}

/** 日期平移：纯 UTC 日历日运算（不碰本地时区，避免东八区把窗口挪一天）。 */
function shiftDate(date: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
