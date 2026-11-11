/**
 * 连板天梯 3 日数据——从 K 线缓存算最近 3 个交易日的梯队 + 晋级率。
 *
 * 为什么不靠归档：归档才 1 天，但 K 线缓存有全历史。涨停 = 日涨幅≥板块阈值，
 * 连板数 = 连续涨停天数。晋级率 = 昨日 N 板今天晋级到 N+1 板的比例。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/ladder-3day.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";

const KLINE = "data/backtest/kline";
const OUT = "data/history/ladder";

function thrOf(code: string): number {
  return code.startsWith("sz30") || code.startsWith("sh68") ? 0.195 : 0.095;
}

type Bar = { date: string; c: number };

async function main() {
  const files = readdirSync(KLINE).filter((f) => f.endsWith(".json"));
  // 名称 + 今日封单/开板（快照有；历史日 K 线没有封单，留空）
  const nameOf = new Map<string, string>();
  try {
    const uni = JSON.parse(await readFile("data/universe-cache.json", "utf8")) as { payload?: { quotes?: { id: string; name: string }[] } };
    for (const q of uni.payload?.quotes ?? []) nameOf.set(q.id, q.name);
  } catch { /* 无 universe 就退化为代码 */ }
  const todayInfo = new Map<string, { seal?: number; breaks?: number }>();
  try {
    const snap = JSON.parse(await readFile("data/signals/limit-pools-today.json", "utf8")) as { date: string; limitUp: { id?: string; sealFund?: number; breaks?: number }[] };
    for (const r of snap.limitUp) if (r.id) todayInfo.set(r.id, { seal: r.sealFund, breaks: r.breaks });
  } catch { /* skip */ }

  // 收集所有交易日期，取最后 5 个（3 日展示 + 2 日算 streak）
  const allDates = new Set<string>();
  const data = new Map<string, Bar[]>();
  for (const f of files) {
    const id = f.replace(".json", "");
    try {
      const kl = JSON.parse(await readFile(`${KLINE}/${f}`, "utf8")) as Bar[];
      if (!Array.isArray(kl) || kl.length < 2) continue;
      data.set(id, kl);
      for (const b of kl.slice(-6)) allDates.add(b.date);
    } catch {
      /* skip */
    }
  }
  const dates = [...allDates].sort().slice(-5); // 5 天：算 streak 用
  const show = dates.slice(-3); // 展示后 3 天

  // 每只票、每天：涨停? + 连板数
  const limitByStockDate = new Map<string, Map<string, boolean>>();
  const streakByStockDate = new Map<string, Map<string, number>>();
  for (const [id, kl] of data) {
    const lim = new Map<string, boolean>();
    const st = new Map<string, number>();
    const thr = thrOf(id);
    let run = 0;
    const dateIdx = new Map(kl.map((b, i) => [b.date, i]));
    for (const d of dates) {
      const i = dateIdx.get(d);
      if (i == null || i === 0) {
        lim.set(d, false);
        st.set(d, 0);
        run = 0;
        continue;
      }
      const chg = kl[i].c / kl[i - 1].c - 1;
      const isLimit = chg >= thr;
      lim.set(d, isLimit);
      run = isLimit ? run + 1 : 0;
      st.set(d, run);
    }
    limitByStockDate.set(id, lim);
    streakByStockDate.set(id, st);
  }

  // 组装：每天 → 每个板位 → 股票列表
  type Row = { id: string; name: string; streak: number; seal?: number; breaks?: number };
  const ladder: Record<string, Record<string, Row[]>> = {};
  for (const d of show) {
    const byStreak: Record<string, Row[]> = {};
    for (const [id, st] of streakByStockDate) {
      const s = st.get(d) ?? 0;
      if (s < 1) continue;
      const key = String(s);
      const info = todayInfo.get(id);
      (byStreak[key] ??= []).push({ id, name: nameOf.get(id) ?? id, streak: s, seal: info?.seal, breaks: info?.breaks });
    }
    ladder[d] = byStreak;
  }

  // 晋级率：昨日 N 板今天晋级 N+1 板
  const promotion: Record<string, Record<string, { total: number; promoted: number }>> = {};
  for (let k = 1; k < show.length; k += 1) {
    const today = show[k];
    const yday = show[k - 1];
    const p: Record<string, { total: number; promoted: number }> = {};
    for (const [id, st] of streakByStockDate) {
      const ys = st.get(yday) ?? 0;
      const ts = st.get(today) ?? 0;
      if (ys < 1) continue;
      const key = String(ys);
      p[key] ??= { total: 0, promoted: 0 };
      p[key].total += 1;
      if (ts === ys + 1) p[key].promoted += 1;
    }
    promotion[today] = p;
  }

  await mkdir(OUT, { recursive: true });
  const out = { dates: show, ladder, promotion };
  await writeFile(`${OUT}/latest.json`, JSON.stringify(out, null, 2));

  console.log(`连板天梯 3 日：${show.join(" / ")}`);
  for (const d of show) {
    const levels = Object.keys(ladder[d] ?? {}).sort((a, b) => Number(b) - Number(a));
    const total = levels.reduce((n, lv) => n + (ladder[d][lv]?.length ?? 0), 0);
    console.log(`  ${d}：${total} 只涨停，最高 ${levels[0] ?? 0} 板`);
  }
}

main().catch((e) => {
  console.error("连板天梯 3 日失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
