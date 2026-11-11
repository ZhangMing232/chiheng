/**
 * 这个文件是干什么的：
 * 把日线缓存压成「按日期的一张收盘价快照」——`data/history/closes/2026-11-11.json`
 * 里就是 {sh600000: 12.34, ...}。区间涨幅只要读首尾两张，不用扫 5000 个文件。
 *
 * 为什么不做成一整张矩阵：5324 × 300 个点塞一个 JSON 是几十 MB，
 * 每次页面请求都读一遍内存撑不住。按日切文件，一次只读两张。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/closes-index.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllKlines, tradingDates } from "./lib/kline-store.ts";

const OUT = "data/history/closes";
/** 留多少个交易日。250 是一年，多一点余量应对自定义区间选到一年前。 */
const DAYS = Number(process.env.CLOSES_DAYS ?? 300);

function main() {
  const t0 = Date.now();
  const all = loadAllKlines();
  const dates = tradingDates(all);
  const keep = dates.slice(-DAYS);

  // 只保留需要的日期集合，避免对每只票扫全历史
  const wanted = new Set(keep);
  const byDate = new Map<string, Record<string, number>>();
  for (const d of keep) byDate.set(d, {});

  let bars = 0;
  for (const [code, arr] of all) {
    for (const b of arr) {
      if (!wanted.has(b.date)) continue;
      if (!Number.isFinite(b.c) || b.c <= 0) continue;
      byDate.get(b.date)![code] = Math.round(b.c * 1000) / 1000;
      bars += 1;
    }
    // 注意：这里不能 break，因为每只票的 bars 是升序，但 wanted 分散在尾部，
    // 提前 break 会漏。5000 只 × 500 根 = 250 万次判断，跑一次几秒，值得。

  }

  mkdirSync(OUT, { recursive: true });
  for (const [d, map] of byDate) {
    writeFileSync(join(OUT, `${d}.json`), JSON.stringify(map));
  }
  writeFileSync(
    join(OUT, "dates.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), dates: keep, stocks: all.size, bars }),
  );

  // 名字单独存一份：页面按区间算排行时要显示股票名，每次请求读 1.5MB 的行情缓存太浪费。
  try {
    const uni = JSON.parse(readFileSync("data/universe-cache.json", "utf8")) as {
      payload: { quotes: { id: string; name: string }[] };
    };
    const names: Record<string, string> = {};
    for (const q of uni.payload.quotes) names[q.id] = q.name.replace(/\s+/g, "");
    writeFileSync(join(OUT, "names.json"), JSON.stringify(names));
  } catch {
    console.log("[closes] 行情缓存读不到，names.json 没写（页面会退化成显示代码）");
  }

  console.log(
    `[closes] ${keep.length} 个交易日（${keep[0]} → ${keep[keep.length - 1]}）· ${all.size} 只票 · ${bars} 个收盘点 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

main();
