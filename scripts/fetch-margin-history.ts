/**
 * 这个文件是干什么的：
 * 从东财抓取 2023-01-01 至今所有交易日两融全量数据，每天一个 JSON 落盘到
 * data/risk/margin/YYYY-MM-DD.json。渐进式，已存在的跳过，支持中断后继续。
 *
 * 你需要知道的：
 * - 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-margin-history.ts
 * - 第一天跑会抓 700+ 天，大约 2-3 小时，设计成可以 Ctrl-C 中断后继续的。
 * - 两页之间隔 800ms 控制频率，每天抓完打一行进度。
 * - 东财只保留近 3 年数据（2023 年之前的不用操心）。
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { fetchMarginBook, latestMarginDate } from "@/lib/market/margin";

const OUT_DIR = "data/risk/margin";
const START_DATE = new Date("2023-01-01");

/** 两个日期之间隔多少毫秒 */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 返回 [start, end] 日期闭区间（YYYY-MM-DD 字符串）的所有自然日。
 * 不跳过非交易日——fetchMarginBook 对非交易日返回空行列表就跳过。
 */
function* dateRange(start: Date, end: Date): Generator<string> {
  const cur = new Date(start);
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    yield `${y}-${m}-${d}`;
    cur.setDate(cur.getDate() + 1);
  }
}

/** 一天两融数据落地路径 */
function dayPath(date: string): string {
  return `${OUT_DIR}/${date}.json`;
}

/** 文件存在就 true */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const today = await latestMarginDate();
  if (!today) throw new Error("拿不到东财最新交易日，请检查网络后重试");
  console.log(`东财最新两融交易日：${today}`);

  // 如果用户提前结束过，从已有文件的最新日期断点续跑。
  // 策略很简单：遍历 2023-01-01 → latestMarginDate，文件已经落盘就跳过。
  let total = 0;
  let skipped = 0;
  let fetched = 0;

  for (const date of dateRange(START_DATE, new Date(today))) {
    // 不要跑到未来去
    if (date > today) break;

    if (await exists(dayPath(date))) {
      skipped += 1;
      continue;
    }

    const { book, missing } = await fetchMarginBook(date);

    // 非交易日：API 返回 0 条（东财不报错，rows 就是空数组）
    if (book.rows.length === 0) {
      // 非交易日也落盘一个空文件，避免每次跑都重复请求
      await writeFile(dayPath(date), JSON.stringify({ date, rows: [], fetchedAt: new Date().toISOString() }));
      total += 1;
      console.log(`[margin] ${date} 非交易日 · 跳过`);
      // 非交易日也等 800ms 再打下一请求
      await delay(800);
      continue;
    }

    await writeFile(
      dayPath(date),
      JSON.stringify({ ...book, missing, fetchedAt: new Date().toISOString() }),
    );

    fetched += 1;
    total += 1;
    console.log(`[margin] ${date} OK ${book.rows.length}只` + (missing ? ` · 坏行${missing}条` : ""));

    // 两页之间 fetchMarginBook 内部已经串行发请求了，这里只在天与天之间加延时
    await delay(800);
  }

  console.log(`\n完成：共 ${total} 天（抓取 ${fetched} 天 · 跳过 ${skipped} 天）`);
}

await main();