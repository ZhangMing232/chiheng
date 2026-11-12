/**
 * 补三池历史归档（盯盘「回看」用）。
 *
 * 为什么要有：按日归档是 2026-11-11 才上线的，之前一天都没有。东财 push2ex
 * 实测支持传历史日期，但大约只留最近三周（2026-11-12 实测：11-11/11-10/11-04/
 * 10-30/10-28/10-27/10-23 都有，10-20 及更早返回空）。跑一次把能补的都补上，
 * 以后每天 15:12 的收盘采集自己往里加。
 *
 * 纪律：
 * - 只写 data/history/limit-pools/<date>.json，**绝不碰** limit-pools-today.json
 *   （那份是「今天」的快取，被历史日期覆盖就会让盯盘显示成看昨天的）。
 * - 已有的归档默认跳过，不覆写（收盘定盘的数据不该被重算覆盖）。
 * - 东财返回空就跳过、不写空档；日志写清「接口没返回」，不把 0 当成「那天没涨停」。
 * - 3 池串行 ×1300ms（限速唯一出处 fetch-policy.ts），每天之间再留 2 秒，
 *   不开并发——开并发实测立刻 403。
 *
 * 用法：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs \
 *     scripts/backfill-limit-pools.ts --from 2026-10-23 --to 2026-11-11
 *   # 或补最近 N 个自然日：--days 21
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { collectPools } from "@/lib/market/limit-pools.server";
import { shanghaiDate } from "@/lib/market/session";

const ROOT = process.cwd();
const DIR = `${ROOT}/data/history/limit-pools`;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** 含首尾，按 ISO 日期逐日（字典序＝时间序）。 */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  for (; d <= end; d.setDate(d.getDate() + 1)) {
    out.push(new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10));
  }
  return out;
}

/** 周末跳过：不是「这天没涨停」，是根本不开市。 */
function isWeekend(day: string): boolean {
  const wd = new Date(`${day}T12:00:00+08:00`).getUTCDay();
  return wd === 0 || wd === 6;
}

function atomicWrite(day: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  const full = `${DIR}/${day}.json`;
  const tmp = `${full}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, full);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const today = shanghaiDate();
  const to = arg("to") ?? new Date(Date.now() - 24 * 3_600_000 + 8 * 3_600_000).toISOString().slice(0, 10);
  const daysArg = arg("days");
  const from = arg("from") ?? (daysArg
    ? new Date(Date.now() - (Number(daysArg) - 1) * 24 * 3_600_000 + 8 * 3_600_000).toISOString().slice(0, 10)
    : to);
  const days = dayRange(from, to).filter((d) => d < today && !isWeekend(d));
  console.log(`[backfill] ${from} → ${to}，候选 ${days.length} 个工作日（今天 ${today} 不算）`);

  let wrote = 0;
  let skipped = 0;
  let empty = 0;
  for (const day of days) {
    if (existsSync(`${DIR}/${day}.json`)) {
      console.log(`[backfill] ${day} 已有归档，跳过`);
      skipped++;
      continue;
    }
    let snap;
    try {
      snap = await collectPools(day);
    } catch (e) {
      console.log(`[backfill] ${day} 现拉失败：${e instanceof Error ? e.message : String(e)}`);
      empty++;
      await sleep(2000);
      continue;
    }
    if (!snap.summary || snap.limitUp.length === 0) {
      // 不写空档。超出东财保留窗口 / 节假日 / 接口异常都落在这里，日志说清是「没返回」。
      console.log(`[backfill] ${day} 东财没返回三池（超出保留窗口或非交易日），跳过不写空档`);
      empty++;
      await sleep(2000);
      continue;
    }
    atomicWrite(day, { ...snap, sealed: true });
    console.log(
      `[backfill] ${day} ✓ 涨停 ${snap.limitUp.length} 炸板 ${snap.broken.length} 跌停 ${snap.limitDown.length}`,
    );
    wrote++;
    await sleep(2000);
  }
  console.log(`[backfill] 完成：补了 ${wrote} 天，已有 ${skipped} 天，接口没返回 ${empty} 天`);
}

main().catch((e) => {
  console.error("[backfill] 失败：", e);
  process.exitCode = 1;
});
