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

  const summary = {
    signalDate,
    trackedDate: new Date().toISOString().slice(0, 10),
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