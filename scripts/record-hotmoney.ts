/**
 * 这个文件是干什么的：
 * 把当天的龙虎榜席位账归档到 data/risk/hotmoney/<date>.json，补齐 D3 的「龙虎榜历史」。
 * hotmoney.ts 本身只有 5 分钟内存缓存（当天看），历史回溯靠这个落盘。
 *
 * 你需要知道的：
 * - 用法：收盘后跑 node --experimental-strip-types --import ./scripts/alias.mjs scripts/record-hotmoney.ts
 * - 已存在的日期不覆盖（幂等，重复跑安全）；当天没数据（非交易日）直接退出。
 */

import { mkdir, access, writeFile, rename } from "node:fs/promises";
import { loadHotMoney } from "@/lib/market/hotmoney";

async function main() {
  const book = await loadHotMoney();
  if (!book.date) {
    console.log("东财还没有当天龙虎榜数据（非交易日或未收盘），不归档。");
    return;
  }
  const dir = "data/risk/hotmoney";
  const out = `${dir}/${book.date}.json`;
  try {
    await access(out);
    console.log(`${out} 已存在，不覆盖。`);
    return;
  } catch {
    // 不存在，继续归档
  }
  await mkdir(dir, { recursive: true });
  const tmp = `${out}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...book, archivedAt: new Date().toISOString() }));
  await rename(tmp, out);
  console.log(`归档 ${out}：${book.seats.length} 个席位`);
}

await main();
