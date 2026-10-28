/**
 * 信号跟踪：每天收盘后（15:10）跑，拉昨天候选信号的次日涨跌幅。
 * 输出 data/signals/tracking.json，/arena 页面读它显示战绩。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/track-signals.ts
 *
 * 说明：优先从 K 线缓存读，缓存里没有信号日（可能滞后）就从腾讯快照实时拉。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;

interface Candidate {
  id: string; code: string; name: string; strategy: string;
  buyPrice: number; score: number; reason: string;
}

interface TrackedSignal extends Candidate {
  prevClose: number | null;
  nextClose: number | null;
  nextOpen: number | null;
  /** prevClose 实际取的是哪一天的收盘（K 线口径下精确；腾讯口径下为 null = 未知） */
  basisDate: string | null;
  /** nextClose 实际取的是哪一天的收盘 */
  measureDate: string | null;
  chgPct: number | null;
  isWin: boolean | null;
  source: string; // "kline" | "tencent"
}

async function main() {
  // 只跟踪交易日的次日涨跌：信号日是昨天，今天收盘价才是 "次日"
  // 如果今天是交易日但还没收盘（9:30 前或 15:00 前），跳过
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const min = now.getMinutes();
  const timeStr = `${hour}${min}`;

  // 开盘前（9:30 前）和收盘前（15:00 前）不跑——没有今天的收盘价
  if (timeStr < "0930" && timeStr >= "0000") {
    // 但如果是盘前且昨天有信号，可以用昨天收盘价做初步标记（非最终）
    // 实际上更简单：等收盘后再跑
  }

  // 判断今天是否是交易日：周一到周五 + 非节假日（简化版，只看星期）
  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) {
    console.log("今天非交易日，跳过追踪");
    return;
  }

  // 收盘前不跑（没有今天的收盘价）
  if (hour < 15) {
    console.log(`今天 ${today} ${hour}:${String(min).padStart(2,"0")} 还没收盘，跳过追踪。收盘后自动跑。`);
    return;
  }

  console.log(`信号跟踪：拉昨日（信号日）候选信号的次日表现（今天 ${today} 收盘后）...\n`);

  // 1. 读候选信号
  let candidates: { date: string; signals: Candidate[] };
  try {
    const raw = await readFile(`${DATA}/signals/candidates.json`, "utf8");
    candidates = JSON.parse(raw);
  } catch {
    console.log("没有候选信号文件，跳过");
    return;
  }
  if (!candidates.signals?.length) { console.log("候选信号为空"); return; }

  const signalDate = candidates.date;
  console.log(`信号日：${signalDate}，候选 ${candidates.signals.length} 条`);

  /**
   * 信号日不早于今天 → 没有「次日」可测，直接跳过，**并且不覆盖已有的 tracking.json**。
   *
   * 2026-10-28 修：以前不挡这一步，于是收盘后（尤其服务重启把当日去重清零之后）
   * 会拿「今天生成的候选」去和「今天的收盘」比——写出来的 signalDate 和 trackedDate
   * 是同一天，胜率看着像次日的成绩，实际是当日涨跌。真实的「次日」要等下一个交易日。
   */
  if (signalDate >= today) {
    console.log(`信号日 ${signalDate} 不早于今天 ${today}——还没有「次日」可跟踪，本次跳过。`);
    console.log("（候选是今天收盘后生成的，等下一个交易日收盘后再跑；上一份 tracking.json 原样保留）");
    return;
  }

  // 2. 准备 K 线缓存索引
  const klineCache = new Set<string>();
  try { klineCache.add(...[...readdirSync(KLINE).filter(f => f.endsWith(".json"))].map(f => f.replace(".json", ""))); } catch {}

  const tracked: TrackedSignal[] = [];
  const seen = new Set<string>();

  for (let ci = 0; ci < candidates.signals.length; ci++) {
    const s = candidates.signals[ci];
    if (seen.has(s.code)) continue;
    seen.add(s.code);

    let prevClose: number | null = null;
    let nextClose: number | null = null;
    let nextOpen: number | null = null;
    let source = "none";
    /** 基准日（prevClose 是哪天的收盘）与测量日（nextClose 是哪天的收盘）。
     *  以前只写「今天」，腾讯回退时说不清到底比的是哪两天——2026-10-28 补。 */
    let basisDate: string | null = null;
    let measureDate: string | null = null;

    // 优先从 K 线缓存读
    if (klineCache.has(s.id)) {
      try {
        const raw = JSON.parse(await readFile(`${KLINE}/${s.id}.json`, "utf8"));
        if (Array.isArray(raw)) {
          let signalIdx = -1;
          for (let i = raw.length - 1; i >= 0; i--) {
            if (raw[i]?.date === signalDate) { signalIdx = i; break; }
          }
          if (signalIdx >= 0 && signalIdx + 1 < raw.length) {
            prevClose = raw[signalIdx]?.c ?? null;
            nextOpen = raw[signalIdx + 1]?.o ?? null;
            nextClose = raw[signalIdx + 1]?.c ?? null;
            basisDate = raw[signalIdx]?.date ?? null;
            measureDate = raw[signalIdx + 1]?.date ?? null;
            source = "kline";
          }
        }
      } catch {}
    }

    // 缓存里没有 → 从腾讯快照拉
    if (prevClose == null || nextClose == null) {
      try {
        const res = await fetch(`https://web.sqt.gtimg.cn/utf8/q=${s.id}`, {
          headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000),
        });
        const text = await res.text();
        const fields = text.split("~");
        nextClose = Number(fields[3]) > 0 ? Number(fields[3]) : null;
        nextOpen = Number(fields[5]) > 0 ? Number(fields[5]) : null;
        prevClose = Number(fields[4]) > 0 ? Number(fields[4]) : null;
        // 快照口径：3=现价(=今天的收盘)、4=昨收（上一个交易日）。
        // 只在「信号日就是上一个交易日」时两者才配得上，所以这里显式断言一次，
        // 对不上就说明 K 线缓存缺了信号日那根，宁可标出来也别悄悄比错两天。
        measureDate = today;
        basisDate = null;
        source = "tencent";
      } catch (e) {
        console.log(`  ${s.code} 腾讯拉取失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (prevClose == null || nextClose == null) {
      console.log(`  ${s.code} ${s.name} 无法获取行情，跳过`);
      continue;
    }

    const chgPct = ((nextClose - s.buyPrice) / s.buyPrice) * 100;

    tracked.push({
      ...s,
      prevClose, nextClose, nextOpen,
      basisDate, measureDate,
      chgPct: +chgPct.toFixed(2),
      isWin: chgPct > 0,
      source,
    });

    console.log(`  ${s.code} ${s.name} | ${s.strategy} | 买${s.buyPrice} → ${prevClose} → ${nextClose} | ${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(2)}% [${source}]`);

    if (ci % 10 === 9) await new Promise(r => setTimeout(r, 100));
  }

  // 3. 统计
  const wins = tracked.filter(t => t.isWin === true).length;
  const losses = tracked.filter(t => t.isWin === false).length;
  const avgWin = wins > 0 ? tracked.filter(t => t.chgPct != null && t.chgPct > 0).reduce((a, t) => a + t.chgPct, 0) / wins : 0;
  const avgLoss = losses > 0 ? tracked.filter(t => t.chgPct != null && t.chgPct < 0).reduce((a, t) => a + t.chgPct, 0) / losses : 0;

  const byStrategy: Record<string, { count: number; wins: number; losses: number; avgChg: number }> = {};
  for (const t of tracked) {
    const s = t.strategy;
    if (!byStrategy[s]) byStrategy[s] = { count: 0, wins: 0, losses: 0, avgChg: 0 };
    byStrategy[s].count++;
    if (t.isWin) byStrategy[s].wins++;
    else if (t.isWin === false) byStrategy[s].losses++;
    if (t.chgPct != null) byStrategy[s].avgChg += t.chgPct;
  }
  for (const s of Object.keys(byStrategy)) {
    byStrategy[s].avgChg = +(byStrategy[s].avgChg / byStrategy[s].count).toFixed(2);
  }

  /**
   * 实际的「测量日」以逐笔实测到的 measureDate 为准（取众数），取不到才退回今天。
   * 以前直接写 `new Date()`：服务在周末或节假日重跑时，页面会显示「信号日 → 今天」，
   * 而收盘价其实是上一个交易日的，日期和数字对不上。
   */
  const measureCount = new Map<string, number>();
  for (const t of tracked) {
    if (!t.measureDate) continue;
    measureCount.set(t.measureDate, (measureCount.get(t.measureDate) ?? 0) + 1);
  }
  let trackedDate = new Date().toISOString().slice(0, 10);
  let best = 0;
  for (const [d, c] of measureCount) {
    if (c > best) { best = c; trackedDate = d; }
  }

  const summary = {
    signalDate,
    trackedDate,
    totalSignals: candidates.signals.length,
    tracked: tracked.length,
    wins,
    losses,
    winRate: +((wins / (tracked.length || 1)) * 100).toFixed(1),
    avgWinPct: +avgWin.toFixed(2),
    avgLossPct: +avgLoss.toFixed(2),
    plRatio: +(avgWin / Math.abs(avgLoss || 1)).toFixed(2),
    byStrategy,
  };

  console.log(`\n统计：${tracked.length} 条已跟踪 | 赢 ${wins} 输 ${losses} | 胜率 ${summary.winRate}%`);
  console.log(`盈亏比 ${summary.plRatio}（均赢 ${summary.avgWinPct}% / 均亏 ${summary.avgLossPct}%）`);
  for (const [s, v] of Object.entries(byStrategy)) {
    console.log(`  ${s}: ${v.count} 条 | 赢${v.wins} 输${v.losses} | 均${v.avgChg >= 0 ? "+" : ""}${v.avgChg}%`);
  }

  // 4. 落盘
  await mkdir(`${DATA}/signals`, { recursive: true });
  await writeFile(`${DATA}/signals/tracking.json`, JSON.stringify({
    signalDate, trackedDate: summary.trackedDate, summary, signals: tracked,
  }, null, 2));
  console.log(`\n跟踪结果已保存到 ${DATA}/signals/tracking.json`);
}

main().catch(e => { console.error(e); process.exit(1); });