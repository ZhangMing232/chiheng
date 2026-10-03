/**
 * 这个文件是干什么的：
 * 无前视回测引擎。把选股策略放到历史日线上重跑一遍，看它们到底赚不赚钱。
 *
 * 你需要知道的：
 * 「无前视」是这台机器的唯一铁律——第 t 天收盘后，只准看第 t 天及之前的 K 线。
 * 选出来的股票在**第 t+1 天**才成交，而且只有当天的**最低价**碰到买入价才算成交
 * （限价单，不追高）。出场沿用 journal-book 的 exitFill，它已经处理了 T+1，
 * 并且同一天两边都碰到时按最坏情况（先止损）算。
 *
 * 已知的三处近似，读结果时要心里有数：
 * 1. 股票池是「今天还在交易的股票」，已退市的不在里面，结果偏乐观（幸存者偏差）
 * 2. 历史换手率、市值、市盈率拿不到，只能用量价替代 —— 所以 value 那套回测不了
 * 3. 成交额用「成交量 × 收盘价」折算，与实际成交额略有出入
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { exitFill } from "@/lib/market/journal-book";
import type { Bar } from "@/lib/market/types";

/** 回测多长。250 个交易日约等于一年。 */
const LOOKBACK = 250;
/** 抽多少只股票。全市场五千多只全拉太慢，抽样已经能看出方向。 */
const SAMPLE = Number(process.env.BT_SAMPLE ?? 300);
/** 每套策略每天最多买几只，和线上一致。 */
const MAX_POSITIONS = 10;
/** 一来一回的手续费，和线上一致。 */
const FEE = 0.00102;
const CACHE = "data/backtest/kline";
const KLINE_HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" };

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

async function fetchKline(id: string, noFq = false): Promise<Row[]> {
  // 指数没有复权数据，带 qfq 会返回 501，只能取原始 day
  const url = noFq
    ? `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,${LOOKBACK + 80}`
    : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,${LOOKBACK + 80},qfq`;
  const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
  const rows = body.data?.[id]?.qfqday ?? body.data?.[id]?.day ?? [];
  const out: Row[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const o = Number(r[1]);
    const c = Number(r[2]);
    const h = Number(r[3]);
    const l = Number(r[4]);
    const v = Number(r[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    out.push({ date: r[0], o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

async function loadKlines(ids: string[]): Promise<Map<string, Row[]>> {
  await mkdir(CACHE, { recursive: true });
  const out = new Map<string, Row[]>();
  let done = 0;
  let notedError = false;
  const queue = [...ids];
  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      let rows: Row[] | null = null;
      try {
        const cached = await readFile(`${CACHE}/${id}.json`, "utf8");
        const parsed = JSON.parse(cached) as Row[];
        if (Array.isArray(parsed) && parsed.length > 0) rows = parsed;
      } catch {
        rows = null;
      }
      if (!rows) {
        for (let attempt = 0; attempt < 3 && !rows; attempt += 1) {
          try {
            rows = await fetchKline(id);
            if (rows.length > 0) await writeFile(`${CACHE}/${id}.json`, JSON.stringify(rows));
          } catch (error) {
            if (attempt === 2 && !notedError) {
              notedError = true;
              console.error(`  取 ${id} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      }
      if (done < 3) process.stderr.write(`  [诊断] ${id} -> ${rows ? rows.length + " 根" : "空"}\n`);
      if (rows && rows.length > LOOKBACK) out.set(id, rows);
      done += 1;
      if (done % 50 === 0) process.stderr.write(`  已取 ${done}/${ids.length} 只\n`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return out;
}

/** 只用第 i 天及之前的数据算指标。这是「无前视」的落地点。 */
function metrics(rows: Row[], i: number) {
  const at = (k: number) => (i - k >= 0 ? rows[i - k].c : null);
  const c = rows[i].c;
  const pct = (base: number | null) => (base && base > 0 ? ((c - base) / base) * 100 : null);
  const prev = i - 1 >= 0 ? rows[i - 1].c : c;
  const chg = prev > 0 ? ((c - prev) / prev) * 100 : 0;
  const vol = rows[i].v;
  const avg5 = avg(rows.slice(Math.max(0, i - 4), i + 1).map((r) => r.v));
  const avg20 = avg(rows.slice(Math.max(0, i - 19), i + 1).map((r) => r.v));
  return {
    c,
    prev,
    chg,
    d5: pct(at(5)),
    d20: pct(at(20)),
    d60: pct(at(60)),
    volRatio: avg5 > 0 ? vol / avg5 : 0,
    volShrink: avg20 > 0 ? avg5 / avg20 : 1,
    // 成交量单位是手，×100 股 × 价格 = 元，再换成万元
    amountWan: (vol * 100 * c) / 1e4,
    limit: /^(30|68)/.test(rows[i].date) ? 20 : 10,
  };
}

function avg(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

type Signal = { buy: number; stop: number; sell: number; score: number };

/** 趋势回踩：20 日涨 10%~40%，60 日至少 5%，今天跌 0~4%，买在昨收。 */
function trend(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d20 == null || m.d60 == null) return null;
  if (m.d20 < 10 || m.d20 > 40 || m.d60 < 5) return null;
  if (m.chg > 1 || m.chg < -4) return null;
  if (m.amountWan < 5000 || m.volRatio < 0.8) return null;
  if (m.c < 4) return null;
  const buy = m.prev;
  const give = stopPct ?? Math.max(3, m.d20 * 0.25);
  const stop = buy * (1 - give / 100);
  const sell = buy * (1 + Math.max(40 - m.d20, give) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.d20 };
}

/** 放量突破：量比至少 1.8，买在昨收上方 2%，止损放昨收。 */
function breakout(m: ReturnType<typeof metrics>): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  if (m.volRatio < 1.8) return null;
  if (m.amountWan < 8000) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 20) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  if (m.c < 4) return null;
  const buy = m.prev * 1.02;
  const stop = m.prev;
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10 };
}

/** 启动前期：今天涨 1%~4.5%，买在涨幅中位，止损按涨幅上限。 */
function early(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  if (m.chg < 1 || m.chg > 4.5) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < -3 || m.d20 > 12 || m.d60 < -10 || m.d60 > 25) return null;
  if (m.volRatio < 1.2 || m.volRatio > 2.8) return null;
  if (m.amountWan < 5000 || m.c < 4) return null;
  const buy = m.prev * (1 + 2.75 / 100);
  const room = 12 - m.d20;
  const targetPct = Math.max(room, 4.5);
  const stop = Math.min(buy * (1 - (stopPct ?? 4.5) / 100), m.prev * (1 + 1 / 100));
  const sell = buy * (1 + targetPct / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.d20 };
}

/**
 * 缩量超跌反转（新策略）。
 * 依据：A 股日内收益对未来呈反转效应，且短周期下更强；低换手/缩量的票更被忽视。
 * 条件全部只用已知信息：连跌、缩量、没进入长期下降通道。
 */
function reversal(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  // 5 日跌 5%~12%：跌到位但没崩
  if (m.d5 > -5 || m.d5 < -12) return null;
  // 抛压衰竭：近 5 日均量不足 20 日均量的七成
  if (m.volShrink > 0.7) return null;
  // 不是长期阴跌
  if (m.d60 < -20) return null;
  // 当天已经反弹太多就不追
  if (m.chg > 3 || m.chg < -3) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;
  const buy = m.prev * 0.99;
  const stop = buy * (1 - (stopPct ?? 6) / 100);
  const sell = buy * 1.08;
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: -m.d5 };
}

const STRATEGIES = {
  trend: { label: "趋势回踩", fn: trend },
  breakout: { label: "放量突破", fn: breakout },
  early: { label: "启动前期", fn: early },
  reversal: { label: "缩量反转(新)", fn: reversal },
} as const;

type StyleKey = keyof typeof STRATEGIES;

type Trade = { id: string; date: string; entry: number; exit: number; reason: string; ret: number; hold: number };

async function main() {
  console.log("无前视回测：只用在 t 日收盘时已知的信息，t+1 日按限价单成交\n");

  const uniRes = await fetch("https://qt.gtimg.cn/q=sh000001", { headers: KLINE_HEADERS });
  if (!uniRes.ok) throw new Error("连不上行情");
  void uniRes;

  // 股票池：用新浪全市场快照拿代码（东财 clist 在这台机器不通）
  const ids: string[] = [];
  // 新浪按代码升序排，bj 段会排在 sh/sz 前面，所以要多翻几页；北交所票日线太短，排除。
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const list = (await res.json()) as { symbol?: string }[];
    if (list.length === 0) break;
    for (const row of list) {
      const s = row.symbol ?? "";
      if (/^(sh|sz)\d{6}$/.test(s)) ids.push(s);
    }
  }
  // 等距抽样，覆盖各个代码段
  const step = Math.max(1, Math.floor(ids.length / SAMPLE));
  const sample = ids.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  console.log(`股票池 ${ids.length} 只，抽样 ${sample.length} 只\n`);

  const klines = await loadKlines(sample);
  console.log(`取到日线 ${klines.size} 只\n`);

  const bench = await fetchKline("sh000300", true);
  const benchStart = bench.length > LOOKBACK ? bench[bench.length - LOOKBACK].c : null;
  const benchEnd = bench.length > 0 ? bench[bench.length - 1].c : null;
  const benchRet = benchStart && benchEnd ? (benchEnd - benchStart) / benchStart : 0;

  // 逐日推进：t 日收盘后选股，t+1 日成交
  const dates = [...(klines.values().next().value as Row[] | undefined ?? [])].map((r) => r.date);
  const startIdx = Math.max(0, dates.length - LOOKBACK);
  const endDate = dates[dates.length - 1] ?? "";
  const startDate = dates[startIdx] ?? "";
  console.log(`回测区间 ${startDate} ~ ${endDate}（${dates.length - startIdx} 个交易日）\n`);

  // 环境总闸：沪深 300 在 20 日均线下方时，认为逆风，当天不开新仓
  const useFilter = process.env.BT_FILTER === "1";
  function bullishAt(date: string): boolean {
    const i = bench.findIndex((r) => r.date === date);
    if (i < 20) return false;
    const ma20 = avg(bench.slice(i - 19, i + 1).map((r) => r.c));
    return bench[i].c > ma20;
  }

  function runPass(stopPct?: number): Record<string, Trade[]> {
  const results: Record<string, Trade[]> = {};
  for (const key of Object.keys(STRATEGIES)) results[key] = [];

  // 样本外验证：把区间劈成前后两段分别跑，看参数是不是只在这段数据上好看
  const half = process.env.BT_HALF;
  const mid = Math.floor((startIdx + dates.length - 2) / 2);
  const from = half === "second" ? mid : startIdx;
  const to = half === "first" ? mid : dates.length - 2;

  for (let t = from; t < to; t += 1) {
    if (useFilter && !bullishAt(dates[t])) continue;
    const picks: Record<string, { id: string; sig: Signal }[]> = {};
    for (const key of Object.keys(STRATEGIES)) picks[key] = [];

    for (const [id, rows] of klines) {
      // 找到这只票在第 t 天的位置：只能用 <= t 的数据
      const idx = rows.findIndex((r) => r.date === dates[t]);
      if (idx < 61) continue;
      const m = metrics(rows, idx);
      for (const [key, def] of Object.entries(STRATEGIES)) {
        const sig = def.fn(m, stopPct);
        if (sig) picks[key].push({ id, sig });
      }
    }

    for (const [key, list] of Object.entries(picks)) {
      list.sort((a, b) => b.sig.score - a.sig.score);
      for (const pick of list.slice(0, MAX_POSITIONS)) {
        const rows = klines.get(pick.id);
        if (!rows) continue;
        const nextIdx = rows.findIndex((r) => r.date === dates[t + 1]);
        if (nextIdx < 0) continue;
        const bar = rows[nextIdx];
        // 限价单：当天最低价碰到买入价才成交，成交价按买入价算
        if (bar.l > pick.sig.buy) continue;
        const fill = exitFill(
          rows as Bar[],
          bar.date,
          pick.sig.buy,
          pick.sig.stop,
          pick.sig.sell,
          10,
        );
        if (!fill) continue;
        const ret = (fill.price - pick.sig.buy) / pick.sig.buy - FEE;
        const hold = rows.findIndex((r) => r.date === fill.date) - nextIdx;
        results[key].push({
          id: pick.id,
          date: bar.date,
          entry: pick.sig.buy,
          exit: fill.price,
          reason: fill.reason,
          ret,
          hold,
        });
      }
    }
  }
  return results;
  }

  function report(results: Record<string, Trade[]>, title: string) {
  console.log(title);
  console.log("策略            笔数   胜率    平均收益   累计收益   平均持有  最大连亏");
  console.log("-".repeat(76));
  for (const [key, def] of Object.entries(STRATEGIES)) {
    const trades = results[key];
    if (trades.length === 0) {
      console.log(`${def.label.padEnd(14)} 0 笔（区间内没出现符合条件的票）`);
      continue;
    }
    const wins = trades.filter((t) => t.ret > 0).length;
    const sum = trades.reduce((s, t) => s + t.ret, 0);
    const avg = sum / trades.length;
    const hold = trades.reduce((s, t) => s + t.hold, 0) / trades.length;
    let streak = 0;
    let worst = 0;
    for (const t of trades) {
      if (t.ret <= 0) {
        streak += 1;
        worst = Math.max(worst, streak);
      } else streak = 0;
    }
    console.log(
      def.label.padEnd(14) +
        String(trades.length).padEnd(6) +
        `${((wins / trades.length) * 100).toFixed(0)}%`.padEnd(7) +
        `${(avg * 100).toFixed(2)}%`.padStart(8) +
        `${(sum * 100).toFixed(1)}%`.padStart(11) +
        `${hold.toFixed(1)} 天`.padStart(10) +
        String(worst).padStart(9),
    );
  }
  console.log("-".repeat(76));
  }

  if (process.env.BT_SWEEP === "1") {
    console.log("止损幅度扫描（同一套选股条件，只改止损百分比）\n");
    for (const stopPct of [2, 3, 4, 5, 6]) {
      report(runPass(stopPct), `止损 -${stopPct}%:`);
      console.log("");
    }
    console.log(`同期沪深 300 买入持有：${(benchRet * 100).toFixed(1)}%（作为参照）`);
  } else {
    const stopOverride = process.env.BT_STOP ? Number(process.env.BT_STOP) : undefined;
    report(runPass(stopOverride), process.env.BT_HALF ? `区间：${process.env.BT_HALF} 段` : "");
    console.log(`同期沪深 300 买入持有：${(benchRet * 100).toFixed(1)}%（作为参照）`);
  }
  console.log("\n注：单笔收益率等权累加，不是复利；样本含幸存者偏差，实际会差一些。");
}

await main();
