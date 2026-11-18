/**
 * 这个文件是干什么的：
 * 「启动前兆扫描」的历史回测验证（2026-11-18 用户要求：不要解释为什么没找到，
 * 要能提前找到涨得最好的）。
 *
 * 方法：用 data/history/closes 的 306 个交易日全市场收盘价，逐日模拟收盘扫描，
 * 看命中的票在**之后 1/3/5 日**的真实表现，和全市场基准对比。
 * 这是检验规则有没有用的唯一诚实方式——不是拿用户举的三只票反推参数。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/early-signal-backtest.ts [天数]
 * 输出：data/early-signal-backtest.json
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Closes = Record<string, number>;

async function main() {
  const lookbackDays = Number(process.argv[2] ?? 40);

  // 读交易日列表
  const datesRaw = JSON.parse(await readFile("data/history/closes/dates.json", "utf8")) as { dates?: string[] };
  const dates = (datesRaw.dates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  // 用全部可用数据（300 天），但扫描窗从第 60 天开始（要算 d60）、到倒数第 6 天结束（要看未来 5 日）
  const useDates = dates;
  if (useDates.length < 10) {
    console.error("[backtest] 历史天数不足");
    process.exit(0);
  }

  // 逐日读收盘价
  const closeByDay = new Map<string, Closes>();
  for (const d of useDates) {
    try {
      closeByDay.set(d, JSON.parse(await readFile(`data/history/closes/${d}.json`, "utf8")) as Closes);
    } catch {
      /* 缺这天就跳过 */
    }
  }
  const dayList = [...closeByDay.keys()].sort();

  // 每日前的价格索引已就绪（closeByDay），直接用日期查，避免序列对齐问题
  const results: { date: string; picks: number; avgR1: number | null; avgR3: number | null; avgR5: number | null; hitRate1: number | null }[] = [];

  // 逐日扫描
  for (let i = 60; i < dayList.length - 6; i++) {
    const today = dayList[i];
    const todayCloses = closeByDay.get(today)!;
    const picks: string[] = [];

    for (const [id, price] of Object.entries(todayCloses)) {
      if (!(price > 0)) continue;
      const c20 = closeByDay.get(dayList[i - 20])?.[id];
      const c60 = closeByDay.get(dayList[i - 60])?.[id];
      const prevClose = closeByDay.get(dayList[i - 1])?.[id];
      if (!c20 || !c60 || !prevClose) continue;
      const d20 = (price / c20 - 1) * 100;
      const d60 = (price / c60 - 1) * 100;
      const chgToday = (price / prevClose - 1) * 100;

      // 前兆条件（只用价格能算的）：
      // ① 今天不是涨停（< 9.5%）——还没启动
      // ② 位置低：d60 < 30% 且 d20 < 15%
      // ③ 今天在涨（0 < chg <= 9.5%）——有启动迹象但不极端
      if (chgToday >= 9.5 || chgToday <= 0) continue;
      if (!(d60 < 30 && d20 < 15)) continue;
      picks.push(id);
    }

    // 算这些 picks 未来 1/3/5 日收益
    const fwd = (n: number): number | null => {
      const vals: number[] = [];
      for (const id of picks) {
        const now = todayCloses[id];
        const later = closeByDay.get(dayList[i + n])?.[id];
        if (now > 0 && later > 0) vals.push((later / now - 1) * 100);
      }
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const r1 = fwd(1);
    const r3 = fwd(3);
    const r5 = fwd(5);
    // 命中率：未来1日为正的比例
    let hit1: number | null = null;
    if (picks.length) {
      const vals = picks
        .map((id) => {
          const now = todayCloses[id];
          const later = closeByDay.get(dayList[i + 1])?.[id];
          return now > 0 && later > 0 ? later / now - 1 : null;
        })
        .filter((v): v is number => v != null);
      hit1 = vals.length ? vals.filter((v) => v > 0).length / vals.length : null;
    }
    results.push({ date: today, picks: picks.length, avgR1: r1, avgR3: r3, avgR5: r5, hitRate1: hit1 });
  }

  // 全市场基准（同期所有票的未来1日平均）
  const baselineR1: number[] = [];
  for (let i = 60; i < dayList.length - 1; i++) {
    const today = closeByDay.get(dayList[i])!;
    const next = closeByDay.get(dayList[i + 1])!;
    for (const [id, p] of Object.entries(today)) {
      if (p > 0 && next[id] > 0) baselineR1.push((next[id] / p - 1) * 100);
    }
  }
  const baseAvg = baselineR1.length ? baselineR1.reduce((a, b) => a + b, 0) / baselineR1.length : null;

  const valid = results.filter((r) => r.picks > 0 && r.avgR1 != null);
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  const out = {
    at: new Date().toISOString(),
    span: { from: dayList[60], to: dayList[dayList.length - 1], days: valid.length },
    limitation:
      "历史 closes 只有收盘价，没有量比/主力净流入——本回测只能用「涨幅+位置」两个条件，" +
      "比线上扫描少两条。线上版多了量能和资金流入，理论上应该更准，但无法用这份数据验证。",
    picksPerDay: mean(valid.map((r) => r.picks)),
    avgR1: mean(valid.map((r) => r.avgR1)),
    avgR3: mean(valid.map((r) => r.avgR3)),
    avgR5: mean(valid.map((r) => r.avgR5)),
    hitRate1: mean(valid.map((r) => r.hitRate1)),
    baselineR1: baseAvg,
    /** 超额 = 命中票 - 全市场 */
    edgeR1: mean(valid.map((r) => r.avgR1)) != null && baseAvg != null ? (mean(valid.map((r) => r.avgR1))! - baseAvg) : null,
    perDay: results,
  };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(process.cwd(), "data", "early-signal-backtest.json"), JSON.stringify(out, null, 2));
  console.log(`[backtest] ${out.span.from} → ${out.span.to}（${out.span.days} 天有命中）`);
  console.log(`  每日命中 ${out.picksPerDay?.toFixed(1)} 只`);
  console.log(`  次日平均 ${out.avgR1?.toFixed(3)}% | 3日 ${out.avgR3?.toFixed(3)}% | 5日 ${out.avgR5?.toFixed(3)}%`);
  console.log(`  全市场次日基准 ${out.baselineR1?.toFixed(3)}% → 超额 ${out.edgeR1?.toFixed(3)}pp`);
  console.log(`  次日命中率 ${(out.hitRate1! * 100).toFixed(1)}%`);
}

await main();
