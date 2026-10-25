/**
 * 这个文件是干什么的：
 * 因子「死因档案」。queue 里 tombstone 的因子以前只在 factor-queue.json 里灰显，
 * 原因只有 note 一行字，跑过几轮、败在哪几关、谁提的，全都随队列状态翻篇——
 * AI  prompt 里倒是有一句败因摘要，但那是给人看的转述，不是档案。
 *
 * 学的是 deepseek-harness-quant 的「17+ 项证伪留档」：失败是资产不是耻辱，
 * 公开存档，避免自己和 AI 反复踩同一个坑（也避免 AI 换个名字重新提议
 * 已被证伪的方向）。
 *
 * 你需要知道的：
 * 1. 纯函数（diffTombstones / buildRecord）不碰 fs，直接单测；
 *    追加和读取在最外层，data 目录约定和 factor-queue.ts 同一套
 *    （CHIHENG_DATA_DIR 可换，data/ 在 .gitignore 里）。
 * 2. 档案落 data/backtest/factor-tombstones.jsonl，一行一条、只追加不改——
 *    和 factor-runs.jsonl 同一取舍：历史不许改。
 * 3. 「怎么死的」分两种：6 关没过（verdict 带 failedGates）和衰减退役
 *    （decay 路径转 tombstone，verdict 里没有 failedGates，cause 为空，
 *    原因看 note）。两种都是 tombstone，但死因档案里要分得开。
 */

import type { QueueEntry, QueueVerdict } from "./factor-queue.ts";

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

/** 一条淘汰档案。 */
export type TombstoneRecord = {
  id: string;
  name: string;
  category: string;
  direction: 1 | -1;
  /** 谁提的。AI 提的淘汰率本身是「AI 管理行不行」的证据。 */
  source: "ai" | "manual";
  /** 淘汰时刻（ISO）。 */
  diedAt: string;
  /** 一生共跑过几轮、最后连续失败几次。 */
  runs: number;
  failCount: number;
  /** 队列里留下的那句话（6 关淘汰 / 衰减退役的原文）。 */
  note: string;
  /**
   * 败在哪几关，如 ["g1","g3"]。衰减退役没有这一关信息，是空数组
   * ——空数组 = 不是 6 关打死的，别读成「全过」。
   */
  failedGates: string[];
  /** 当时的经济逻辑（预登记原文）。档案连「当初为什么信它」一起留。 */
  rationale: string;
  /** 当时的表达式。之后想复活这个方向，从原式出发而不是从零猜。 */
  expr: string;
};

/**
 * 这一轮回写里**新变成 tombstone** 的条目。before/after 各是一份队列快照，
 * 返回新数组不改入参。decayed 不算——它只是停跑，还没死。
 */
export function diffTombstones(before: QueueEntry[], after: QueueEntry[]): QueueEntry[] {
  const beforeStatus = new Map(before.map((e) => [e.id, e.status]));
  return after.filter((e) => e.status === "tombstone" && beforeStatus.get(e.id) !== "tombstone");
}

/** 队列条目 + 判决 → 一条档案。判决里没有这条（理论上不该发生）也能归档，死因记空。 */
export function buildRecord(entry: QueueEntry, verdict: QueueVerdict | undefined): TombstoneRecord {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    direction: entry.direction,
    source: entry.source,
    diedAt: verdict?.at ?? new Date().toISOString(),
    runs: entry.runs,
    failCount: entry.failCount,
    note: entry.note ?? "",
    failedGates: verdict?.failedGates ?? [],
    rationale: entry.rationale,
    expr: entry.expr,
  };
}

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const tombstonePath = () => posixJoin(dataDir(), "backtest", "factor-tombstones.jsonl");

/** 追加一批档案。读不到旧文件不影响追加（从头建）。 */
export async function appendTombstones(records: TombstoneRecord[]): Promise<void> {
  if (records.length === 0) return;
  const { appendFile, mkdir } = await fsApi();
  await mkdir(posixJoin(dataDir(), "backtest"), { recursive: true });
  await appendFile(tombstonePath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** 读全部档案。文件不存在/坏了 → 空数组，绝不抛错（和 readQueue 同一取舍）。 */
export async function readTombstones(): Promise<TombstoneRecord[]> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(tombstonePath(), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TombstoneRecord);
  } catch {
    return [];
  }
}
