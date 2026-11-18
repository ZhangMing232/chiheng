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

  // 3. 逐日算：龙虎榜净买票的后续表现（分游资/机构两档）
  type Result = { date: string; inst: number[]; ret1: number; ret3: number; ret5: number; n: number };
  const byDay: Result[] = [];
  const allBase: { r1: number[]; r3: number[]; r5: number[] } = { r1: [], r3: [], r5: [] };

  for (const [date, file] of seatsByDay) {
    const i = dayIndex.get(date);
    if (i == null || i + 5 >= dayList.length) continue;
    const todayCloses = closeByDay.get(dayList[i])!;

    // 聚合当日每只票的净买入（游资 + 机构分开）
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

    const fwd = (id: string, n: number): number | null => {
      const now = todayCloses[id];
      const later = closeByDay.get(dayList[i + n])?.[id];
      return now > 0 && later > 0 ? (later / now - 1) * 100 : null;
    };

    // 游资净买 > 3000 万且超过机构（跟着游资走，不是跟机构）
    const picks: { id: string; net: number }[] = [];
    for (const [id, net] of hotNet) {
      if (net < 3000) continue;
      const inst = instNet.get(id) ?? 0;
      if (inst > net) continue; // 机构主导的不跟
      picks.push({ id, net });
    }
    if (picks.length === 0) continue;

    const r1s = picks.map((p) => fwd(p.id, 1)).filter((v): v is number => v != null);
    const r3s = picks.map((p) => fwd(p.id, 3)).filter((v): v is number => v != null);
    const r5s = picks.map((p) => fwd(p.id, 5)).filter((v): v is number => v != null);
    if (r1s.length === 0) continue;

    byDay.push({
      date,
      inst: [],
      ret1: r1s.reduce((a, b) => a + b, 0) / r1s.length,
      ret3: r3s.length ? r3s.reduce((a, b) => a + b, 0) / r3s.length : 0,
      ret5: r5s.length ? r5s.reduce((a, b) => a + b, 0) / r5s.length : 0,
      n: picks.length,
    });

    // 全市场基准（同日）
    for (const [id, p] of Object.entries(todayCloses)) {
      if (!(p > 0)) continue;
      const a = fwd(id, 1), b = fwd(id, 3), c = fwd(id, 5);
      if (a != null) allBase.r1.push(a);
      if (b != null) allBase.r3.push(b);
      if (c != null) allBase.r5.push(c);
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const picks1 = byDay.map((d) => d.ret1);
  const picks3 = byDay.map((d) => d.ret3);
  const picks5 = byDay.map((d) => d.ret5);

  const out = {
    at: new Date().toISOString(),
    rule:
      "龙虎榜游资席净买入 > 3000 万，且游资净买 > 机构净买（跟游资不跟机构）；" +
      "次日/3日/5日按收盘价计（不扣费，不含滑点）",
    days: byDay.length,
    avgPicksPerDay: mean(byDay.map((d) => d.n)),
    pickR1: mean(picks1),
    pickR3: mean(picks3),
    pickR5: mean(picks5),
    baseR1: mean(allBase.r1),
    baseR3: mean(allBase.r3),
    baseR5: mean(allBase.r5),
    edgeR1: mean(picks1) != null && mean(allBase.r1) != null ? mean(picks1)! - mean(allBase.r1)! : null,
    edgeR3: mean(picks3) != null && mean(allBase.r3) != null ? mean(picks3)! - mean(allBase.r3)! : null,
    edgeR5: mean(picks5) != null && mean(allBase.r5) != null ? mean(picks5)! - mean(allBase.r5)! : null,
    hitRate1: picks1.length ? picks1.filter((x) => x > 0).length / picks1.length : null,
    perDay: byDay,
  };
  await writeFile(join(process.cwd(), "data", "seat-signal-backtest.json"), JSON.stringify(out, null, 2));

  console.log(`[seat-backtest] 有效 ${out.days} 天，每日平均 ${out.avgPicksPerDay?.toFixed(1)} 只`);
  console.log(`  次日 ${out.pickR1?.toFixed(3)}% vs 基准 ${out.baseR1?.toFixed(3)}% → 超额 ${out.edgeR1?.toFixed(3)}pp`);
  console.log(`  3日  ${out.pickR3?.toFixed(3)}% vs 基准 ${out.baseR3?.toFixed(3)}% → 超额 ${out.edgeR3?.toFixed(3)}pp`);
  console.log(`  5日  ${out.pickR5?.toFixed(3)}% vs 基准 ${out.baseR5?.toFixed(3)}% → 超额 ${out.edgeR5?.toFixed(3)}pp`);
  console.log(`  日胜率 ${(out.hitRate1! * 100).toFixed(1)}%`);
}

await main();
