/**
 * 涨停原因采集（对标弈盘/连板网的「为什么涨」）。
 *
 * 数据源：yipanai.com 的公开接口（逆向自其 ladder 页，免登录）：
 *   /api/limit-up/reason?code=<6位代码>        → 个股涨停原因（转发韭研公社 jiuyan）
 *   /api/limit-up/sector-reason?industry=<概念> → 板块爆发原因（转发开盘啦 GetDayBaseFaceListZDEvnArt）
 *
 * 为什么用它的接口而不是直连韭研/开盘啦：那两个源要么要登录、要么接口带签名，
 * 它这里已经做好了聚合+免登录，是当前唯一能白嫖的稳定出口。
 *
 * 纪律：
 * - 每次请求之间留间隔（默认 250ms），不把人家接口打爆。
 * - 结果按日归档到 data/history/limit-up-reasons/<date>.json，当天只采一次（幂等）。
 * - 采不到就是采不到，字段空着，不编。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-limit-up-reason.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BASE = "https://www.yipanai.com/api/limit-up";
const DELAY = Number(process.env.REASON_DELAY ?? 250);
const OUT_DIR = "data/history/limit-up-reasons";

type PoolRow = { code?: string; name?: string; streak?: number | null };
type ReasonRow = {
  code: string;
  name: string;
  primary_concept: string;
  theme: string;
  reason: string;
  source: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
      if (res.ok) return await res.json();
    } catch {
      /* 重试一次 */
    }
    await sleep(400 * (attempt + 1));
  }
  return null;
}

async function main() {
  // 1. 读今天的涨停池快照（capture-market-snapshot.ts 15:12 落盘）
  let snap: { date: string; limitUp: PoolRow[] } | null = null;
  try {
    snap = JSON.parse(await readFile("data/signals/limit-pools-today.json", "utf8"));
  } catch {
    console.error("没有 data/signals/limit-pools-today.json，先跑 capture-market-snapshot.ts");
    process.exit(1);
  }
  if (!snap) process.exit(1);
  const date = snap.date; // 2026-11-11
  const ymd = date.replace(/-/g, ""); // 20261111
  const codes = snap.limitUp.map((r) => r.code).filter((c): c is string => !!c);
  console.log(`涨停 ${codes.length} 只，开始采原因（${date}）...`);

  await mkdir(OUT_DIR, { recursive: true });

  // 2. 逐只采个股原因
  const reasons: Record<string, ReasonRow> = {};
  let ok = 0;
  let empty = 0;
  for (const code of codes) {
    const d = (await fetchJson(`${BASE}/reason?code=${code}`)) as
      | { code?: string; name?: string; primary_concept?: string; theme?: string; reason?: string; source?: string }
      | null;
    if (d && (d.reason || d.theme)) {
      reasons[code] = {
        code,
        name: d.name ?? "",
        primary_concept: d.primary_concept ?? "",
        theme: d.theme ?? "",
        reason: d.reason ?? "",
        source: d.source ?? "",
      };
      ok += 1;
    } else {
      empty += 1;
    }
    await sleep(DELAY);
  }
  console.log(`个股原因：采到 ${ok} / 空 ${empty}`);

  // 3. 采板块爆发原因（用 reason 里出现最多的 primary_concept）
  const conceptCount = new Map<string, number>();
  for (const r of Object.values(reasons)) {
    if (r.primary_concept) conceptCount.set(r.primary_concept, (conceptCount.get(r.primary_concept) ?? 0) + 1);
  }
  const topConcepts = [...conceptCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  const sectors: Record<string, { title: string; reason: string; date: string }[]> = {};
  for (const concept of topConcepts) {
    const d = (await fetchJson(`${BASE}/sector-reason?industry=${encodeURIComponent(concept)}`)) as
      | { rows?: { title?: string; reason?: string; date?: string }[]; available?: boolean }
      | null;
    if (d?.rows?.length) {
      sectors[concept] = d.rows.slice(0, 3).map((x) => ({ title: x.title ?? "", reason: x.reason ?? "", date: x.date ?? "" }));
    }
    await sleep(DELAY);
  }
  console.log(`板块原因：采到 ${Object.keys(sectors).length} 个概念`);

  // 4. 落盘
  const out = { date: ymd, fetchedAt: new Date().toISOString(), ok, empty, reasons, sectors };
  await writeFile(`${OUT_DIR}/${date}.json`, JSON.stringify(out, null, 2));
  console.log(`已落盘 ${OUT_DIR}/${date}.json`);
}

main().catch((e) => {
  console.error("涨停原因采集失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
