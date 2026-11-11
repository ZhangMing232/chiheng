/**
 * 从本地 K 线缓存算「每日市场结构序列」，供 /cycle 页面用。
 *
 * 为什么从 K 线算而不是抓接口：K 线缓存有全历史（5324 只），抓接口一天配额有限，
 * 而且历史涨停池接口一次只能拿一天。用 K 线算的口径是「日涨幅≥阈值」，
 * 和 ladder-3day.ts、以及回测里的涨停判定是同一套，不会出现两个口径。
 *
 * 已知近似（必须留在文件头，别偷偷改）：
 * - 涨停阈值只分 19.5% / 9.5% 两档，ST 的 5% 没有历史逐日标记，会漏计。
 * - 停牌日用「当日无 bar」处理，不参与等权收益分母。
 * - 新股上市首日涨幅不受限，会被误判成涨停；影响很小但不为零。
 *
 * 用法：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/cycle-history.ts
 * 输出：data/history/cycle/series.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { phaseOf, temperatureOf, tierOf, type DayStat } from "@/lib/market/cycle";

const KLINE = "data/backtest/kline";
const OUT = "data/history/cycle";
/** 往前算多少个交易日。250 日 ≈ 一年，够算分位也够看一个完整周期。 */
const DAYS = 260;
/** 当日有效样本少于这个数，说明缓存缺片，整天丢弃（不拿残缺横截面算温度）。 */
const MIN_SAMPLE = 1500;

type Bar = { date: string; c: number; o?: number; h?: number; l?: number };

function thrOf(code: string): number {
  return code.startsWith("sz30") || code.startsWith("sh68") ? 0.195 : 0.095;
}

async function main(): Promise<void> {
  const files = readdirSync(KLINE).filter((f) => f.endsWith(".json"));
  console.log(`[cycle] 读 ${files.length} 个 K 线文件…`);

  // date → 累加器
  const acc = new Map<
    string,
    { limitUp: number; ladder: number; maxStreak: number; streaks: number[]; up: number; down: number; sumRet: number; n: number }
  >();
  const bump = (date: string) => {
    let a = acc.get(date);
    if (!a) {
      a = { limitUp: 0, ladder: 0, maxStreak: 0, streaks: [], up: 0, down: 0, sumRet: 0, n: 0 };
      acc.set(date, a);
    }
    return a;
  };

  let used = 0;
  for (const f of files) {
    const id = f.replace(".json", "");
    let bars: Bar[];
    try {
      bars = JSON.parse(await readFile(`${KLINE}/${f}`, "utf8")) as Bar[];
    } catch {
      continue;
    }
    if (!Array.isArray(bars) || bars.length < 2) continue;
    used += 1;
    const thr = thrOf(id);
    let run = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const prev = bars[i - 1];
      const cur = bars[i];
      if (!prev || !cur || !(prev.c > 0) || !(cur.c > 0)) {
        run = 0;
        continue;
      }
      const pct = cur.c / prev.c - 1;
      const a = bump(cur.date);
      a.n += 1;
      a.sumRet += pct;
      if (pct > 0.0001) a.up += 1;
      else if (pct < -0.0001) a.down += 1;
      if (pct >= thr) {
        run += 1;
        a.limitUp += 1;
        if (run >= 2) a.ladder += 1;
        if (run > a.maxStreak) a.maxStreak = run;
        a.streaks.push(run);
      } else {
        run = 0;
      }
    }
  }
  console.log(`[cycle] 用了 ${used} 只票，覆盖 ${acc.size} 个交易日`);

  // 只保留样本足够的交易日，按日期升序
  const rows = [...acc.entries()]
    .filter(([, a]) => a.n >= MIN_SAMPLE)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, a]) => ({ date, ...a }));

  const tail = rows.slice(-DAYS);
  const offset = rows.length - tail.length;

  // 第一步：逐日算温度。窗口 = 该日之前的 250 个交易日（**不含当日**），
  // 当日值只在窗口里找它自己的位置。不足 120 日的早期直接 null，不拿半截样本凑分。
  const temps: (number | null)[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const r = tail[i]!;
    const end = offset + i;
    const window = rows.slice(Math.max(0, end - 250), end).map((x) => ({
      limitUp: x.limitUp,
      ladder: x.ladder,
      maxStreak: x.maxStreak,
      up: x.up,
      down: x.down,
    }));
    temps.push(
      temperatureOf({ limitUp: r.limitUp, ladder: r.ladder, maxStreak: r.maxStreak, up: r.up, down: r.down }, window),
    );
  }

  // 第二步：只有算出温度的日期才进序列（早期 120 天空着就空着，不补 0）。
  const kept: number[] = [];
  for (let i = 0; i < tail.length; i += 1) if (temps[i] != null) kept.push(i);

  const series: DayStat[] = [];
  for (const i of kept) {
    const r = tail[i]!;
    const temp = temps[i]!;
    // 5 日温度变化：找序列里往前第 5 个真正有温度的样本
    const at = series.length - 5;
    const priorTemp = at >= 0 ? series[at]!.temp : null;
    const tempDelta5 = priorTemp != null ? Math.round((temp - priorTemp) * 10) / 10 : 0;
    series.push({
      date: r.date,
      limitUp: r.limitUp,
      ladder: r.ladder,
      maxStreak: r.maxStreak,
      byTier: tierOf(r.streaks),
      up: r.up,
      down: r.down,
      eqReturn: Math.round((r.sumRet / r.n) * 1e6) / 1e6,
      n: r.n,
      temp,
      phase: phaseOf(temp, tempDelta5) ?? "冰点",
      tempDelta5,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "data/backtest/kline（日涨幅≥板块阈值）",
    note: "涨停阈值 19.5%/9.5% 两档，ST 未单列；温度=四量滚动中位秩加权；阶段=温度档位+5日温度变化",
    days: series.length,
    series,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/series.json`, JSON.stringify(out, null, 1), "utf8");
  const last = series[series.length - 1];
  console.log(`[cycle] 写出 ${series.length} 天 → ${OUT}/series.json`);
  console.log(`[cycle] 最新：${last?.date} 涨停 ${last?.limitUp} 连板 ${last?.ladder} 最高 ${last?.maxStreak} 板 温度 ${last?.temp} 阶段 ${last?.phase}`);
}

await main();
