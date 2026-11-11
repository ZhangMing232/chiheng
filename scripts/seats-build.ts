/**
 * 这个文件是干什么的：
 * 把 `data/risk/hotmoney/` 的 486 天龙虎榜席位记录，聚成「席位档案」——
 * 每个席位买过多少、净额多少、**跟买之后 5 日赚不赚**。
 *
 * 战绩口径（页面上原文印出来，别偷改）：
 *   席位某日净买入某股 → **次日开盘买入**（当天收盘才知道席位，所以不能按当天价买）
 *   → 持有 5 个交易日后收盘卖出。两个价都是事后真实的，不含未来函数。
 *   名字对不上代码的（改名、退市、一个字差异）直接跳过，计入「无法对齐」计数，不猜。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/seats-build.ts
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { indexByDate, loadAllKlines, type Bar } from "./lib/kline-store.ts";

const SRC = "data/risk/hotmoney";
const OUT = "data/history/seats";
/** 至少出现这么多天才进档案（一天的席位 7000+ 个，全收进来页面没法看）。 */
const MIN_DAYS = 5;
/** 持有多少个交易日结算。 */
const HOLD = 5;
/** 每个席位留多少条最近记录给详情页看。 */
const KEEP_RECORDS = 40;

type DaySeat = { name: string; netWan: number; stocks: { name: string; netWan: number }[] };
type DayFile = { date: string; seats: DaySeat[]; fetchedAt?: string };

function main() {
  const t0 = Date.now();
  const files = readdirSync(SRC).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  const days: DayFile[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(SRC, f), "utf8")) as DayFile;
      if (d.seats && d.seats.length > 0) days.push(d);
    } catch {
      // 坏文件跳过
    }
  }

  const all = loadAllKlines();
  const byId = new Map<string, Map<string, Bar>>();
  for (const [id, bars] of all) byId.set(id, indexByDate(bars));

  // 名字 → 代码。同名多只的（极少）直接放弃，不猜。
  const uni = JSON.parse(readFileSync("data/universe-cache.json", "utf8")) as {
    payload: { quotes: { id: string; name: string }[] };
  };
  const codeByName = new Map<string, string | null>();
  for (const q of uni.payload.quotes) {
    const clean = q.name.replace(/\s+/g, "");
    const prev = codeByName.get(clean);
    codeByName.set(clean, prev === undefined ? q.id : prev === q.id ? q.id : null);
  }

  type Rec = { date: string; stock: string; id: string | null; netWan: number; r1: number | null; r5: number | null };
  type Acc = {
    name: string;
    days: number;
    netWan: number;
    buys: number;
    r5s: number[];
    r1s: number[];
    first: string;
    last: string;
    recs: Rec[];
  };

  const seats = new Map<string, Acc>();
  let unresolved = 0;

  for (const d of days) {
    for (const s of d.seats) {
      let acc = seats.get(s.name);
      if (!acc) {
        acc = { name: s.name, days: 0, netWan: 0, buys: 0, r5s: [], r1s: [], first: d.date, last: d.date, recs: [] };
        seats.set(s.name, acc);
      }
      acc.days += 1;
      acc.netWan += s.netWan;
      acc.last = d.date;
      for (const st of s.stocks ?? []) {
        if (!(st.netWan > 0)) continue; // 只看净买入，净卖出不是「他跟了这只票」
        acc.buys += 1;
        const cleanName = st.name.replace(/\s+/g, "");
        const id = codeByName.get(cleanName) ?? null;
        if (!id) {
          unresolved += 1;
          continue;
        }
        const idx = byId.get(id);
        if (!idx) {
          unresolved += 1;
          continue;
        }
        const entry = idx.get(d.date);
        const bars = all.get(id)!;
        const pos = bars.findIndex((b) => b.date === d.date);
        let r1: number | null = null;
        let r5: number | null = null;
        if (pos >= 0 && entry) {
          const buyBar = bars[pos + 1];
          const sell1 = bars[pos + 1];
          const sell5 = bars[pos + HOLD];
          if (buyBar && buyBar.o > 0) {
            if (sell1) r1 = sell1.c / buyBar.o - 1;
            if (sell5) r5 = sell5.c / buyBar.o - 1;
          }
        }
        if (r1 != null) acc.r1s.push(r1);
        if (r5 != null) acc.r5s.push(r5);
        acc.recs.push({ date: d.date, stock: st.name, id, netWan: Math.round(st.netWan), r1, r5 });
      }
    }
  }

  const rows = [...seats.values()]
    .filter((a) => a.days >= MIN_DAYS)
    .map((a) => {
      const avg5 = a.r5s.length ? a.r5s.reduce((x, y) => x + y, 0) / a.r5s.length : null;
      const win5 = a.r5s.length ? a.r5s.filter((x) => x > 0).length / a.r5s.length : null;
      const avg1 = a.r1s.length ? a.r1s.reduce((x, y) => x + y, 0) / a.r1s.length : null;
      return {
        name: a.name,
        days: a.days,
        netWan: Math.round(a.netWan),
        buys: a.buys,
        avg1,
        avg5,
        win5,
        n5: a.r5s.length,
        first: a.first,
        last: a.last,
        recs: a.recs.slice(-KEEP_RECORDS).reverse(),
      };
    })
    .sort((a, b) => b.netWan - a.netWan);

  const latest = days[days.length - 1];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "latest.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      hold: HOLD,
      minDays: MIN_DAYS,
      sourceDays: days.length,
      sourceFirst: days[0]?.date ?? "",
      sourceLast: latest?.date ?? "",
      unresolved,
      seats: rows,
      latest: latest ? { date: latest.date, seats: latest.seats } : null,
    }),
  );

  const withStats = rows.filter((r) => r.n5 >= 20).length;
  console.log(
    `[seats] ${days.length} 天（${days[0]?.date} → ${latest?.date}）· 席位 ${seats.size} 个，够 ${MIN_DAYS} 天的 ${rows.length} 个 · 有 ≥20 笔可结算的 ${withStats} 个 · 名字对不上代码 ${unresolved} 笔 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  const top = rows.filter((r) => r.n5 >= 20).sort((a, b) => (b.avg5 ?? -9) - (a.avg5 ?? -9));
  console.log("  跟买 5 日最赚（≥20 笔）：");
  for (const r of top.slice(0, 5)) {
    console.log(`   ${r.name} 净额 ${(r.netWan / 10000).toFixed(1)}亿 · ${r.n5} 笔 · 均 ${((r.avg5 ?? 0) * 100).toFixed(2)}% · 胜率 ${((r.win5 ?? 0) * 100).toFixed(0)}%`);
  }
  const bot = top.slice(-3).reverse();
  console.log("  跟买 5 日最亏：");
  for (const r of bot) {
    console.log(`   ${r.name} 净额 ${(r.netWan / 10000).toFixed(1)}亿 · ${r.n5} 笔 · 均 ${((r.avg5 ?? 0) * 100).toFixed(2)}% · 胜率 ${((r.win5 ?? 0) * 100).toFixed(0)}%`);
  }
}

main();
