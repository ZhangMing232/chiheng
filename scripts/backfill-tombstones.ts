/**
 * 这个文件是干什么的：
 * 回填因子死因档案（一次性脚本）。死因档案（factor-tombstones.jsonl）是
 * 后加的功能——功能上线前死掉的因子没有档案，AI 的 prompt 里看不到它们的败关。
 * 本脚本从 factor-runs.jsonl 找回这些因子的最后一次判决，按 TombstoneRecord
 * 形状补进档案。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backfill-tombstones.ts
 *
 * 你需要知道的：
 * - 只追加不覆盖（档案是 append-only 历史，「历史不许改」的纪律对这个脚本同样有效）；
 * - 找不到判决的死因子也补一条档案，failedGates 为空——空数组的意思是
 *   「死因不明」， necropsyLines 会把这类和衰减退役一样标注，绝不读成全过；
 * - 幂等：已归档的 id 跳过，重复跑不会产生重复。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendTombstones, readTombstones, type TombstoneRecord } from "@/lib/market/factor-tombstones";
import type { QueueEntry } from "@/lib/market/factor-queue";
import type { FactorRunRow } from "@/lib/market/factor-runs-file";

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dataDir(), name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const queue = await readJson<{ entries?: QueueEntry[] }>("factor-queue.json", { entries: [] });
  const archived = await readTombstones();
  const archivedIds = new Set(archived.map((record) => record.id));

  const dead = (queue.entries ?? []).filter((entry) => entry.status === "tombstone" && !archivedIds.has(entry.id));
  if (dead.length === 0) {
    console.log("没有需要回填的死因子（档案已完整）。");
    return;
  }

  // factor-runs.jsonl 是 append-only 跑批日志，最后一行该因子就是临终判决。
  let rows: FactorRunRow[] = [];
  try {
    const raw = await readFile(join(dataDir(), "backtest", "factor-runs.jsonl"), "utf8");
    rows = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as FactorRunRow);
  } catch {
    console.log("factor-runs.jsonl 读不到，只能按「死因不明」补录。");
  }

  const records: TombstoneRecord[] = dead.map((entry) => {
    const match =
      rows.findLast((row) => row.factor === entry.id) ??
      rows.findLast((row) => row.factor === entry.expr) ??
      rows.findLast((row) => row.name === entry.name);
    const failedGates = match
      ? (Object.keys(match.gates) as (keyof FactorRunRow["gates"])[]).filter((key) => match.gates[key] === false)
      : [];
    if (!match) console.log(`  ⚠ ${entry.name}（${entry.id}）在跑批日志里找不到判决，按死因不明补录`);
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      direction: entry.direction,
      source: entry.source,
      diedAt: entry.lastRunAt ?? new Date().toISOString(),
      runs: entry.runs,
      failCount: entry.failCount,
      note: entry.note ?? "",
      failedGates,
      rationale: entry.rationale,
      expr: entry.expr,
    };
  });

  await appendTombstones(records);
  console.log(`已回填 ${records.length} 条死因档案（其中死因不明 ${records.filter((record) => record.failedGates.length === 0).length} 条）。`);
}

await main();
