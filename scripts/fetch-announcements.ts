/**
 * 这个文件是干什么的：
 * 全市场公告事件流采集——巨潮（证监会指定披露平台，第一档合规源）按日期拉当日
 * 全市场公告，按事件类目（问询函/减持/业绩预告/立案/质押）过滤落盘。
 *
 * 用法（home-server 每天 15:35 自动跑一次，stamp 去重）：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-announcements.ts
 *
 * 你需要知道的：
 * - 一天 3 页 × 100 条 = 最多 300 条扫描，事件类过滤后通常几十条，单请求串行，
 *   频率上对巨潮完全无压力（法定披露平台，公开查询）。
 * - 落盘 data/announcements/<date>.json，读方：监管异动雷达（radar 附事件列）、
 *   绝望底仓复核（despair-watch 事件过滤）、快讯页全市场事件卡。
 */

import { fetchEventStream } from "../src/lib/market/announcements.ts";

const date = process.argv[2] ?? new Date().toLocaleDateString("sv-SE");
const book = await fetchEventStream(date, { pages: 3, pageSize: 100 });
const byCat = new Map<string, number>();
for (const e of book.events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
console.log(`公告事件流 ${date}：扫描 3 页，命中 ${book.events.length} 条事件`);
for (const [key, n] of byCat) {
  const label = key;
  console.log(`  ${label}: ${n} 条`);
}
