/**
 * 回避窗口 W 调优（#2）。
 *
 * 【口径必须与 backtest-lhb-seats.ts 完全一致】否则两边的数不能比：
 *   进��：事件日 t 的**次日开盘价**（t+1 open）
 *   出场：t+N 收盘价
 *   个股收益 = exit/entry - 1 - COST(0.3% 来回)
 *   超额 = 个股收益 - 沪深300 同期收益（基准从事件日收盘算到出场日收盘）
 *   拖累 = 平均超额为负（该票跑输大盘 → 锁它是对的）
 *
 * 【单位坑】LIVE_AVOID_WIN / BT_AVOID_WIN 是**自然日**，而拖累曲线是**交易日**。
 * 事件日 E 的票被锁到 E+W 自然日；W=20 自然日 ≈ 14 个交易日。
 * 所以「拖累吃到第 N 交易日」需要 W ≈ N * 1.44 自然日。本脚本把换算一并给出。
 *
 * 【分母】误挡率的分母用真实股票宇宙（K 线缓存里的票数），不是「有过事件的票数」
 * ——后者会把分母缩小、误挡率虚高。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-avoid-window.ts
 */
import { loadAvoidIndex } from "@/lib/market/lhb-avoid-index.server";
import { readFile, readdir } from "node:fs/promises";

const CACHE = "data/backtest/kline";
const COST = 0.003;
const MAXN = 90;
const WINDOWS = [5, 10, 15, 20, 25, 30];

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

async function loadKline(code: string): Promise<Row[]> {
  try {
    const p = await readFile(`${CACHE}/${code}.json`, "utf8");
    const rows = JSON.parse(p) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function loadIndex(id: string): Promise<Map<string, number>> {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + id + ",day,,,400";
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("指数取数失败 " + res.status);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const m = new Map<string, number>();
  for (const r of rows) if (Array.isArray(r) && r.length >= 3) m.set(r[0], Number(r[2]));
  return m;
}

/** 自然日 → 该自然日之前（含）可用的交易日序列位置，用于把 W 自然日折成交易日数。 */
function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const idxEvents = await loadAvoidIndex(); // noninst（默认口径）
  const bench = await loadIndex("sh000300");

  // 真实宇宙 = K 线缓存里所有票
  const allFiles = (await readdir(CACHE)).filter((f) => f.endsWith(".json"));
  const universe = allFiles.length;

  // 基准交易日序列
  const benchDates = [...bench.keys()].sort();

  // 收集事件（code, date）+ 预读 K 线
  const events: { code: string; date: string }[] = [];
  const kl = new Map<string, Row[]>();
  for (const [code, dates] of idxEvents) {
    if (!kl.has(code)) kl.set(code, await loadKline(code));
    for (const d of dates) events.push({ code, date: d });
  }

  // 每个事件在每个 N 上算一条交易（t+1 开盘买、t+N 收盘卖），与席位脚本同口径
  // excessByN[N-1] = {excess: number[], count: number}
  const perN: { excess: number[]; benchRets: number[] }[] = [];
  for (let n = 0; n < MAXN; n++) perN.push({ excess: [], benchRets: [] });

  let skippedNoKline = 0;
  let skippedNoIdx = 0;
  for (const ev of events) {
    const k = kl.get(ev.code);
    if (!k || k.length < 3) {
      skippedNoKline++;
      continue;
    }
    const idx = k.findIndex((r) => r.date === ev.date);
    if (idx < 0) {
      skippedNoIdx++;
      continue;
    }
    const bi = bench.get(ev.date);
    if (bi == null || !(bi > 0)) {
      skippedNoIdx++;
      continue;
    }
    const entry = k[idx + 1].o; // 次日开盘
    if (!(entry > 0)) continue;
    for (let n = 1; n <= MAXN; n++) {
      if (idx + n >= k.length) break;
      const exit = k[idx + n].c;
      const be = bench.get(k[idx + n].date);
      if (!(exit > 0) || be == null || !(be > 0)) break;
      const ret = exit / entry - 1 - COST;
      const bret = be / bi - 1;
      perN[n - 1].excess.push(ret - bret);
      perN[n - 1].benchRets.push(bret);
    }
  }

  // 1) 拖累曲线（正确口径：t+1 开盘买 → t+N 收盘卖）
  console.log("事件 " + events.length + "（无K线/无基准跳过 " + (skippedNoKline + skippedNoIdx) + "）");
  console.log("");
  console.log("=== 拖累曲线：事件后 N 交易日平均超额（个股−沪深300，含0.3%成本；越负=回避越值）===");
  console.log("N".padEnd(4) + "笔数".padStart(7) + "平均超额".padStart(10) + "基准平均".padStart(10) + "个股平均".padStart(10));
  const cum: number[] = [];
  for (let n = 1; n <= MAXN; n++) {
    const arr = perN[n - 1].excess;
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    cum.push(mean);
    const bmean = perN[n - 1].benchRets.reduce((s, x) => s + x, 0) / perN[n - 1].benchRets.length;
    console.log(
      String(n).padEnd(4) +
        String(arr.length).padStart(7) +
        ((mean * 100).toFixed(2) + "%").padStart(10) +
        ((bmean * 100).toFixed(2) + "%").padStart(10) +
        (((mean + bmean + COST) * 100).toFixed(2) + "%").padStart(10),
    );
  }
  const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
  console.log("");
  console.log("边际：5→10 " + pct(cum[9] - cum[4]) + "   10→20 " + pct(cum[19] - cum[9]) + "   20→30 " + pct(cum[29] - cum[19]));

  // 2) W（自然日）→ 锁住的交易日数 → 吃到的拖累
  console.log("");
  console.log("=== W（自然日）→ 实际锁住交易日数 → 吃到的拖累（按 W 处的拖累计）===");
  console.log("W".padEnd(4) + "锁住交易日".padStart(10) + "对应N".padStart(8) + "该N拖累".padStart(10) + "每日锁票".padStart(10) + "误挡率".padStart(9));
  for (const W of WINDOWS) {
    // W 自然日锁住 → 约 W/1.44 个交易日；用日历比例精确换算：数一下 E 到 E+W 之间有几个基准交易日
    let lockedDays = 0;
    let cntSum = 0;
    let days = 0;
    for (const T of benchDates) {
      const winStart = shiftDate(T, -W);
      let cnt = 0;
      for (const [code, dates] of idxEvents) {
        if (dates.some((d) => d >= winStart && d <= T)) cnt++;
      }
      cntSum += cnt;
      days++;
    }
    const avgBlocked = cntSum / days;
    // 锁住交易日数：对每个事件日 E，E 到 E+W 之间的基准交易日数（用全量事件，不抽样）
    for (const ev of events) {
      const e = shiftDate(ev.date, W);
      lockedDays += benchDates.filter((d) => d >= ev.date && d <= e).length;
    }
    const avgLocked = lockedDays / events.length;
    const n = Math.min(MAXN, Math.max(1, Math.round(avgLocked)));
    const rate = ((avgBlocked / universe) * 100).toFixed(2) + "%";
    console.log(
      String(W).padEnd(4) +
        avgLocked.toFixed(1).padStart(10) +
        String(n).padStart(8) +
        pct(cum[n - 1]).padStart(10) +
        avgBlocked.toFixed(1).padStart(10) +
        rate.padStart(9),
    );
  }
  console.log("");
  console.log("真实股票宇宙（K线缓存票数）= " + universe);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
