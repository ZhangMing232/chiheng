/**
 * 这个文件是干什么的：
 * 把东财最新交易日的两融个股明细全量抓下来，落盘 data/risk/margin-latest.json。
 * D3 的杠杆数据从此有本地产物，server 只读文件，不实时打东财。
 *
 * 你需要知道的：
 * - 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-margin.ts
 * - 收盘后跑（两融数据 T+1 发布，盘中跑拿到的也是昨天）。
 * - 失败就非零退出，旧文件留着——写一半的文件比没有更害人（write-atomic 同理）。
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { fetchMarginBook, latestMarginDate, marginSummary } from "@/lib/market/margin";

const OUT = "data/risk/margin-latest.json";

async function main() {
  const date = await latestMarginDate();
  if (!date) throw new Error("拿不到两融最新交易日（东财接口没响应）");
  console.log(`东财最新两融交易日：${date}`);
  const { book, missing } = await fetchMarginBook(date);
  const summary = marginSummary(book);
  await mkdir("data/risk", { recursive: true });
  // 同目录 tmp + rename：rename(2) 原子换入，读者要么看到旧文件要么看到新的。
  // 临时名要带 pid + 随机数——固定 `.tmp` 的话两个进程同时跑会写同一个临时文件，
  // 一个 rename 成功后另一个 ENOENT 抛出来，白跑一趟。
  const tmp = `${OUT}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...book, missing, fetchedAt: new Date().toISOString() }));
  await rename(tmp, OUT);
  console.log(`落盘 ${OUT}：${book.rows.length} 只，坏行 ${missing} 条`);
  console.log(
    `全市场融资余额 ${summary.totalRzyeYi.toFixed(0)} 亿 · 当日融资净买 ${summary.totalRzjmeYi.toFixed(1)} 亿 · 有占比数据 ${summary.withRatio} 只`,
  );
}

await main();
