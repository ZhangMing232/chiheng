/**
 * 这个文件是干什么的：
 * 龙虎榜事件驱动回测（2026-11-18）。用户要「提前找到涨得最好的」——
 * 价格形态那条路已回测证明无效（超额 0），换事件驱动：
 * 龙虎榜是「已知有大资金动手」的证据，比价格形态更有信息量。
 *
 * 回测什么：某日龙虎榜净买入的票，之后 1/3/5 日表现 vs 全市场基准。
 * 分档看：游资席位 vs 机构席位分别如何（这两类资金的性质完全不同）。
 *
 * 数据：data/risk/hotmoney/<date>.json（491 天）+ data/history/closes（收盘价）
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/seat-signal-backtest.ts
 * 输出：data/seat-signal-backtest.json
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legalReturn, limitUpSealed, ROUND_TRIP_COST_PCT, type LegalBar } from "../src/lib/market/backtest-legality.ts";

type SeatFile = {
  date: string;
  seats: { name: string; netWan: number; stocks: { name: string; netWan: number }[] }[];
};

/** 机构席位名（用于分档；其余算游资/营业部） */
const isInst = (name: string) => /机构|沪股通|深股通|北向/.test(name);

async function main() {
  // 1. 读所有龙虎榜日
  const files = (await readdir("data/risk/hotmoney")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const seatsByDay = new Map<string, SeatFile>();
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(join("data/risk/hotmoney", f), "utf8")) as SeatFile;
      if (d.seats?.length) seatsByDay.set(d.date, d);
    } catch {
      /* 坏文件跳过 */
    }
  }
  console.log(`[seat-backtest] 龙虎榜 ${seatsByDay.size} 天`);

  // 2. 读收盘价（只读龙虎榜覆盖范围内的日期）
  const namesRaw = JSON.parse(await readFile("data/history/closes/names.json", "utf8")) as Record<string, string>;
  const nameToId = new Map<string, string>();
  for (const [id, name] of Object.entries(namesRaw)) {
    const clean = name.replace(/\s+/g, "");
    if (!nameToId.has(clean)) nameToId.set(clean, id);
  }

  const datesRaw = JSON.parse(await readFile("data/history/closes/dates.json", "utf8")) as { dates?: string[] };
  const allDates = (datesRaw.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const closeByDay = new Map<string, Record<string, number>>();
  for (const d of allDates) {
    try {
      closeByDay.set(d, JSON.parse(await readFile(`data/history/closes/${d}.json`, "utf8")) as Record<string, number>);
    } catch {
      /* 缺就跳过 */
    }
  }
  const dayList = [...closeByDay.keys()].sort();
  const dayIndex = new Map(dayList.map((d, i) => [d, i]));

  // 3. 逐日算：龙虎榜净买票的后续表现（合法口径：T+1 开盘买、T+2 卖）
  //    ⚠️ 2026-11-18 修正：原版用信号日收盘价买入（未来函数）+ 当日买卖（违反 T+1），
  //    得出的 +0.975pp 超额是假的。现在走 legalReturn 强制合法。
  const byDay: { date: string; n: number; r1: number }[] = [];
  const allReturns: number[] = [];
  let skippedSealed = 0;

  for (const [date, file] of seatsByDay) {
    const i = dayIndex.get(date);
    if (i == null || i + 3 >= dayList.length) continue;

    // 聚合当日每只票的净买入
    const hotNet = new Map<string, number>();
    const instNet = new Map<string, number>();
    for (const seat of file.seats) {
      const inst = isInst(seat.name);
      for (const s of seat.stocks ?? []) {
        const id = nameToId.get(s.name.replace(/\s+/g, ""));
        if (!id) continue;
        if (inst) instNet.set(id, (instNet.get(id) ?? 0) + s.netWan);
        else hotNet.set(id, (hotNet.get(id) ?? 0) + s.netWan);
      }
    }

    const picks: string[] = [];
    for (const [id, net] of hotNet) {
      if (net < 3000) continue;
      if ((instNet.get(id) ?? 0) > net) continue;
      picks.push(id);
    }
    if (picks.length === 0) continue;

    // 用 K 线算合法收益（需要开高低收，closes 只有收盘价 → 拉腾讯 K 线）
    const dayReturns: number[] = [];
    for (const id of picks.slice(0, 5)) {
      try {
        const { loadKline } = await import("../src/lib/market/quotes.functions.ts");
        const kl = await loadKline(id);
        const legalBars: LegalBar[] = kl.bars
          .filter((b) => b.o > 0 && b.c > 0)
          .map((b) => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c }));
        const sigIdx = legalBars.findIndex((b) => b.date === date);
        if (sigIdx < 0 || sigIdx + 1 >= legalBars.length) continue;
        // 一字板买不进
        if (limitUpSealed(legalBars[sigIdx + 1], legalBars[sigIdx].c)) {
          skippedSealed++;
          continue;
        }
        const r = legalReturn(date, legalBars, 1, "open"); // T+1 开盘买 → T+2 开盘卖
        if ("pct" in r && r.pct != null) dayReturns.push(r.pct - ROUND_TRIP_COST_PCT);
      } catch {
        /* K 线拉不到就跳过 */
      }
    }
    if (dayReturns.length === 0) continue;
    const dayAvg = dayReturns.reduce((a, b) => a + b, 0) / dayReturns.length;
    byDay.push({ date, n: dayReturns.length, r1: dayAvg });
    allReturns.push(...dayReturns);
  }

  // 基准：同期全市场（用 closes 算不了合法收益，改用「同批票等权」对照不可行；
  // 这里只报绝对收益，不给虚假超额——基准需要开高低收，历史 closes 没有）
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const out = {
    at: new Date().toISOString(),
    legality:
      "合法口径：T日龙虎榜 → T+1 开盘买入 → T+2 开盘卖出（A股 T+1，最早只能隔日卖）；" +
      `已扣往返成本 ${ROUND_TRIP_COST_PCT}%；一字板买不进的样本已剔除`,
    rule: "龙虎榜游资席净买入 > 3000 万，且游资净买 > 机构净买（跟游资不跟机构）",
    days: byDay.length,
    samples: allReturns.length,
    skippedSealed,
    avgPerTrade: mean(allReturns),
    hitRate: allReturns.length ? allReturns.filter((x) => x > 0).length / allReturns.length : null,
    perDay: byDay,
  };
  await writeFile(join(process.cwd(), "data", "seat-signal-backtest.json"), JSON.stringify(out, null, 2));

  console.log(`[seat-backtest] 合法口径（T+1开盘买→T+2开盘卖，已扣费 ${ROUND_TRIP_COST_PCT}%）`);
  console.log(`  有效 ${out.days} 天 / ${out.samples} 笔（一字板剔除 ${out.skippedSealed}）`);
  console.log(`  单笔平均 ${out.avgPerTrade?.toFixed(3)}% | 笔胜率 ${(out.hitRate! * 100).toFixed(1)}%`);
}

await main();
