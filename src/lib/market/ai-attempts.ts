/**
 * AI 调用的**轮级尝试摘要**（data/ai-attempts.json）。
 *
 * 为什么需要它（2026-11-06 体检）：`callAIWithFallback` 主档案超时后切备用档案，
 * 只要有一个成功，上层闭环就把整轮记成 `ok: true`——ai-log 112 轮里只显示 9 条失败，
 * 而 ai-usage 224 次调用里实际有 49 次失败（37 次是 150 s 超时被掐）。
 * **中间的超时被 fallback 洗掉了**，看 ai-log 会严重低估 AI 的真实失败率。
 *
 * 和另外两本账的分工，别混：
 * - `ai-usage.json`：每次 HTTP 调用的 token/耗时/费用（调用级，已有）。
 * - `ai-log.json`：**整轮闭环**跑成没跑成、提了几个提案（轮级，结果是布尔）。
 * - `ai-attempts.json`（本文件）：一轮里试了几个档案、各自耗时成败、有没有超时
 *   （轮级明细）。它把「ok 但其实中途挂过一次」这件事显式留痕。
 *
 * ⚠️ 浏览器兼容：本文件经 factor-queue.ts 进客户端闭包，node API 必须函数内
 * 动态 import；路径拼接用 posixJoin（同 ai-usage.ts / ai-log.ts 的规矩）。
 */
const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

export type AIAttempt = {
  /** 第几个档案（1 = 主档案）。 */
  index: number;
  profileId: string | null;
  /** 这次给它的超时预算（毫秒）。 */
  timeoutMs: number;
  /** 实际耗时（毫秒）。 */
  ms: number;
  ok: boolean;
  /** 失败分类：timeout / http429 / http / network / empty / aborted / other。 */
  errorKind: string | null;
  /** 错误原话（截断到 200 字，不记 token / apiKey）。 */
  error?: string;
};

export type AIAttemptRound = {
  at: string;
  layer: string;
  trigger: string;
  /** 整轮耗时。 */
  ms: number;
  /** 最终交付成功没有（和 ai-log 的 ok 同义）。 */
  ok: boolean;
  attempts: AIAttempt[];
  /** 这轮里挂掉过几次、其中几次是超时。为的是一眼看出「成功但中途失败过」。 */
  failed: number;
  timedOut: number;
  /** 走的 DSH 桥接还是直连。 */
  via: "dsh" | "direct";
};

export const AI_ATTEMPTS_CAP = 500;

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}
function attemptsPath(): string {
  return posixJoin(dataDir(), "ai-attempts.json");
}

export async function readAIAttempts(): Promise<AIAttemptRound[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(attemptsPath(), "utf8")) as { rounds?: AIAttemptRound[] };
    return Array.isArray(parsed.rounds) ? parsed.rounds : [];
  } catch {
    return [];
  }
}

/** 追加一轮。写失败只打日志——观测账本不该把 AI 调用炸掉。 */
export async function appendAIAttemptRound(round: AIAttemptRound): Promise<void> {
  try {
    const rounds = [...(await readAIAttempts()), round];
    const trimmed = rounds.length > AI_ATTEMPTS_CAP ? rounds.slice(rounds.length - AI_ATTEMPTS_CAP) : rounds;
    const { mkdir, writeFile } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(attemptsPath(), JSON.stringify({ rounds: trimmed }, null, 2));
  } catch (error) {
    console.error("ai-attempts 写入失败（不影响调用结果）:", (error as Error).message);
  }
}

/** 失败分类：纯函数，给流水和未来的告警用。不含任何密钥。 */
export function classifyAIError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("aborted") || m.includes("timeout") || m.includes("超时")) return "timeout";
  if (m.includes("429") || m.includes("rate limit")) return "http429";
  if (m.includes("fetch failed") || m.includes("econn") || m.includes("network")) return "network";
  if (m.includes("http 4") || m.includes("http 5")) return "http";
  if (m.includes("没有内容") || m.includes("empty")) return "empty";
  return "other";
}

/** 是否「成功但中途挂过」——体检要看的就是这种隐性失败。 */
export function isSilentFallback(round: AIAttemptRound): boolean {
  return round.ok && round.failed > 0;
}

/** 聚合统计，纯函数（ops-check / 页面都能用）。 */
export function attemptStats(rounds: AIAttemptRound[]): {
  rounds: number;
  okRounds: number;
  silentFallbacks: number;
  failedAttempts: number;
  timedOut: number;
  totalMs: number;
} {
  return {
    rounds: rounds.length,
    okRounds: rounds.filter((r) => r.ok).length,
    silentFallbacks: rounds.filter(isSilentFallback).length,
    failedAttempts: rounds.reduce((n, r) => n + r.failed, 0),
    timedOut: rounds.reduce((n, r) => n + r.timedOut, 0),
    totalMs: rounds.reduce((n, r) => n + r.ms, 0),
  };
}
