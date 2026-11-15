/**
 * 这个文件是干什么的：
 * 全市场公告事件流采集——巨潮（证监会指定披露平台，第一档合规源）按类目分别
 * 拉当日全市场公告，按事件类目过滤后**原子落盘** data/announcements/<date>.json。
 *
 * 用法（home-server 每天 15:40 起按 60s tick 自动跑，按自然日、可补采）：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-announcements.ts
 *   node ... scripts/fetch-announcements.ts 2026-11-15          # 指定日期补采
 *   node ... scripts/fetch-announcements.ts 2026-11-15 --force  # 已有账也重采
 *
 * 你需要知道的（2026-11-15 复检修正）：
 * - 巨潮公告**周末/节假日也有**（实测 11-14 周六 800 条、11-08 周日 4 条），
 *   采集按自然日跑，不再用 isMarketOpen 跳过。
 * - 按 5 个事件类目各查一次、按 totalpages 翻完，覆盖率和 scanned 一起落盘。
 * - 原子落盘在 lib 内（tmp+rename），半截 JSON 不会被当成已采集。
 */

import { fetchEventStream, loadEventStream, EVENT_CATEGORIES } from "../src/lib/market/announcements.ts";

const date = process.argv[2] ?? new Date().toLocaleDateString("sv-SE");
const force = process.argv.includes("--force");

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`日期格式不对：${date}（要 YYYY-MM-DD）`);
  process.exit(1);
}

if (!force) {
  const existing = await loadEventStream(date);
  if (existing && existing.date === date && existing.events.length >= 0 && Object.keys(existing.scanned).length > 0) {
    console.log(`公告事件流 ${date} 已采集（${existing.events.length} 条事件），跳过。要重采加 --force`);
    process.exit(0);
  }
}

const book = await fetchEventStream(date, { maxPages: 10, pageSize: 100 });
const byCat = new Map<string, number>();
for (const e of book.events) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
console.log(`公告事件流 ${date}：命中 ${book.events.length} 条事件`);
for (const cat of EVENT_CATEGORIES) {
  const n = byCat.get(cat.key) ?? 0;
  console.log(`  ${cat.label}: ${n} 条（${cat.query} 查询扫到 ${book.scanned[cat.key] ?? 0} 条原始公告）`);
}
