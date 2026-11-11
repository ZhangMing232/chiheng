/**
 * 市场情报采集——把弈盘 yipanai 的公开 hotspot 接口拉下来落盘。
 *
 * 数据源（逆向自 yipanai workspace/hotspot 页，免登录，部分字段锁）：
 *   /api/hotspot/news-interpretation    → 新闻解读（新闻→题材→个股传导，带重要度+依据）
 *   /api/hotspot/announcements/structured → 公告分组计数（精选/并购重组/业绩披露…）
 *
 * 纪律：
 * - 只采不锁的字段；锁了的（featured/daily-picks）跳过。
 * - 按日落盘 data/history/market-intel/<date>.json，当天只采一次（幂等）。
 * - 第三方聚合接口，哪天挂了就降级为空，不编。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-market-intel.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "Mozilla/5.0";
const BASE = "https://www.yipanai.com/api/hotspot";
const OUT = "data/history/market-intel";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  for (let i = 0; i < 2; i += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return null;
}

type NewsCard = {
  id?: string;
  title?: string;
  time?: string;
  importance?: number;
  theme?: string;
  summary?: string;
  reason?: string;
  benefits?: { name?: string; reason?: string }[];
  stocks?: { code?: string; name?: string }[];
};

type AnnGroup = { name?: string; count?: number };

async function main() {
  const date = new Date().toISOString().slice(0, 10);

  // 1. 新闻解读
  const newsRaw = (await getJson(`${BASE}/news-interpretation`)) as { cards?: NewsCard[] } | null;
  const cards = (newsRaw?.cards ?? []).map((c) => ({
    title: c.title ?? "",
    time: c.time ?? "",
    importance: c.importance ?? 0,
    theme: c.theme ?? "",
    summary: (c.summary ?? "").slice(0, 400),
    reason: (c.reason ?? "").slice(0, 300),
    benefits: (c.benefits ?? []).map((b) => b.name ?? "").filter(Boolean),
    stocks: (c.stocks ?? []).map((s) => s.name ?? "").filter(Boolean).slice(0, 8),
  }));
  cards.sort((a, b) => b.importance - a.importance);
  console.log(`新闻解读：${cards.length} 条`);

  await sleep(600);

  // 2. 公告分组
  const annRaw = (await getJson(`${BASE}/announcements/structured`)) as { groups?: AnnGroup[]; total?: number } | null;
  const annGroups = (annRaw?.groups ?? []).map((g) => ({ name: g.name ?? "", count: g.count ?? 0 }));
  console.log(`公告分组：${annGroups.length} 类`);

  // 3. 落盘
  const out = { date, fetchedAt: new Date().toISOString(), cards, annGroups, annTotal: annRaw?.total ?? 0 };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/${date}.json`, JSON.stringify(out, null, 2));
  console.log(`已落盘 ${OUT}/${date}.json`);

  // 4. 打印前几条（方便看效果）
  for (const c of cards.slice(0, 5)) {
    console.log(`\n[${c.importance}] ${c.title.slice(0, 40)}`);
    console.log(`  题材: ${c.theme || "—"} | 板块: ${c.benefits.join("、") || "—"}`);
    console.log(`  个股: ${c.stocks.slice(0, 6).join("、") || "—"}`);
  }
}

main().catch((e) => {
  console.error("市场情报采集失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
