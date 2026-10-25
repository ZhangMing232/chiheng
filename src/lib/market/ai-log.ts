/**
 * 这个文件是干什么的：
 * AI 运行账本（data/ai-log.json）——自我迭代的记忆。AI 每跑一轮闭环（因子层 /
 * 策略层、手动 / 自动触发）都记一条：提议了什么、被拒原因、错在哪。下一轮闭环
 * 的 prompt 会读到这些条目对应的**当前下场**（提议的因子过没过 6 关、提名的
 * 挑战者转正还是淘汰），让 AI 基于自己的历史成败纠错，而不是每轮从零开始。
 *
 * 你需要知道的：
 * 1. 这是 AI 自我进化的核心闭环：提议 → 判决 → 回读下场 → 下一轮提议。
 *    没有这本账，AI 永远不知道自己上周提了啥、后来怎么样了。
 * 2. 账本最多留 500 条，满了丢最旧的（FIFO）；data/ 在 .gitignore 里。
 * 3. 自动进化（记账进程收盘后触发）靠账本去重：今天已有 trigger=auto 的记录
 *    就不再跑，保证每天最多一轮。
 * 4. 纯函数（自我历史组装、统计）不依赖 fs，直接单测。
 */

import type { QueueEntry } from "./factor-queue.ts";
import type { Challenger } from "./challenger.ts";

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 factor-queue.ts（debate/research 路由文件静态引用链）进客户端闭包，
 * node API 必须函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 */
const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

// ── 数据结构 ────────────────────────────────────────────────────

export type AILogEntry = {
  /** ISO 时间。 */
  at: string;
  /** factor = 因子提议层；strategy = 挑战者提名层；agent = 全局诊断层（agent-loop.ts，只诊断不行动）。 */
  layer: "factor" | "strategy" | "agent";
  /** manual = 人在 /ai 页点按钮；auto = 记账进程收盘后自动跑。 */
  trigger: "manual" | "auto";
  /** 这轮闭环整体跑成没有（配置缺失 / 调接口失败 = false，照样记账）。 */
  ok: boolean;
  /** 通过校验进了队列 / 挑战者名单的提案。 */
  proposed: { id: string; name: string }[];
  /** 被拒原因（前几条）。 */
  rejected: string[];
  error?: string;
  /** 诊断备注：空返回等「跑了但没产出」的情况，留原始响应摘要。 */
  note?: string;
};

/** 账本上限，满了丢最旧的。 */
export const AI_LOG_CAP = 500;

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const aiLogPath = () => posixJoin(dataDir(), "ai-log.json");

/** 读账本。文件不存在或坏了 → 空数组，绝不抛错。 */
export async function readAILog(): Promise<AILogEntry[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(aiLogPath(), "utf8")) as { entries?: unknown };
    if (Array.isArray(parsed.entries)) return parsed.entries as AILogEntry[];
  } catch {
    // 没有账本 = 还没跑过，正常。
  }
  return [];
}

/** 追加一条。日志写失败不抛错——记账失败不该把闭环本身炸掉。 */
export async function appendAILog(entry: AILogEntry): Promise<void> {
  try {
    const entries = [...(await readAILog()), entry];
    const trimmed = entries.length > AI_LOG_CAP ? entries.slice(entries.length - AI_LOG_CAP) : entries;
    const { mkdir, writeFile } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(aiLogPath(), JSON.stringify({ entries: trimmed }, null, 2));
  } catch (error) {
    console.error("ai-log 写入失败（不影响闭环结果）:", (error as Error).message);
  }
}

// ── 纯函数：自我历史（prompt 用）────────────────────────────────

function outcomeOfQueue(e: QueueEntry | undefined): string {
  if (!e) return "没进队列（校验被拒或本轮没提）";
  if (e.status === "passed") return `已过 6 关（跑过 ${e.runs} 次）`;
  if (e.status === "tombstone") return `已淘汰（连续 ${e.failCount} 次未过 6 关）`;
  if (e.status === "tested") return `在验·未过（连续失败 ${e.failCount} 次，满 2 次淘汰）`;
  return "待验（还没跑过回测）";
}

function outcomeOfChallenger(c: Challenger | undefined): string {
  if (!c) return "没进名单（校验被拒或本轮没提）";
  if (c.status === "promoted") return "已转正为冠军";
  if (c.status === "rejected") return "已淘汰（Welch 判决质量不过关）";
  if (c.status === "inconclusive") return "停跑·未分胜负";
  return "在跑（攒样本中）";
}

function roundLabel(e: AILogEntry): string {
  return `${e.at.slice(0, 16).replace("T", " ")}${e.trigger === "auto" ? "·自动" : ""}`;
}

/**
 * 因子层的自我历史：每轮闭环提议了哪些因子、它们现在什么下场。
 * 给 prompt 的「你自己之前提议的下场」段用；只回最近 maxRounds 轮。
 */
export function factorSelfHistory(log: AILogEntry[], entries: QueueEntry[], maxRounds = 8): string[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return log
    .filter((e) => e.layer === "factor")
    .slice(-maxRounds)
    .flatMap((e) => e.proposed.map((p) => `- ${roundLabel(e)}：你提议「${p.name}」（${p.id}）——${outcomeOfQueue(byId.get(p.id))}`));
}

/** 策略层的自我历史，逻辑同 factorSelfHistory。 */
export function strategySelfHistory(log: AILogEntry[], chals: Challenger[], maxRounds = 8): string[] {
  const byId = new Map(chals.map((c) => [c.id, c]));
  return log
    .filter((e) => e.layer === "strategy")
    .slice(-maxRounds)
    .flatMap((e) => e.proposed.map((p) => `- ${roundLabel(e)}：你提名「${p.name}」（${p.id}）——${outcomeOfChallenger(byId.get(p.id))}`));
}

// ── 纯函数：进化统计（/ai 页看板）───────────────────────────────

export type EvolveStats = {
  factorRounds: number;
  strategyRounds: number;
  /** 队列里 AI 提议的因子总数（含已淘汰）。 */
  factorProposed: number;
  factorPassed: number;
  factorTombstoned: number;
  /** AI 提名的挑战者总数（含已淘汰）。 */
  chalNominated: number;
  chalPromoted: number;
  chalRejected: number;
};

/** AI 提名的挑战者：有 source 字段按字段认，老数据（AI 提议写在 note 里）按前缀认。 */
export function isAIChallenger(c: Challenger): boolean {
  return c.source === "ai" || (!c.source && (c.note ?? "").startsWith("AI 提议"));
}

/** 从账本 + 当前队列/名单算进化统计。数字都是直接计数，不加工。 */
export function evolveStats(log: AILogEntry[], entries: QueueEntry[], chals: Challenger[]): EvolveStats {
  const aiFactors = entries.filter((e) => e.source === "ai");
  const aiChals = chals.filter(isAIChallenger);
  return {
    factorRounds: log.filter((e) => e.layer === "factor").length,
    strategyRounds: log.filter((e) => e.layer === "strategy").length,
    factorProposed: aiFactors.length,
    factorPassed: aiFactors.filter((e) => e.status === "passed").length,
    factorTombstoned: aiFactors.filter((e) => e.status === "tombstone").length,
    chalNominated: aiChals.length,
    chalPromoted: aiChals.filter((c) => c.status === "promoted").length,
    chalRejected: aiChals.filter((c) => c.status === "rejected").length,
  };
}
