/**
 * 这个文件是干什么的：
 * 「前瞻回验」的数据层。两件事：
 *
 * 1) **落档**（`--log`）：收盘后按固定规则从今天的盘面挑 3 只，写进
 *    `data/history/forecast/<date>.json`，带 `lockedAt`。这一版的定位是「当晚发布、
 *    次日对照」，所以**落档之后不许改**——要改就在新的一天改规则，历史留疤。
 *
 * 2) **口径回算**（`--backtest`）：拿同一套规则在过去 N 个交易日重新跑一遍，
 *    用当天能拿到的数据挑票、用次日真实成交价结算。**这是事后重算，不是当时发布的
 *    清单**，页面上必须单独放、单独标，不许和真落档的战绩混在一起算。
 *
 * 规则（两边完全一样，只用 K 线能算出来的量，保证可比）：
 *   ① 最高板：连板数最大，并列取放量倍数大的
 *   ② 次高板：连板数第二大
 *   ③ 首板放量王：连板数 1 的里面，放量倍数（当日量 / 前 5 日均量）最大的
 *
 * 结算口径：T 日收盘后挑票（此时只知道 T 日收盘）→ **T+1 开盘买入**（这是最早能成交的价）
 * → T+1 收盘算「次日涨幅」→ T+1 最高价算「买后高点」。全是盘后才知道的价，不含未来函数。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/forecast.ts --log
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/forecast.ts --backtest
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { barAfter, limitPct, loadAllKlines, tradingDates, type Bar } from "./lib/kline-store.ts";

const OUT = "data/history/forecast";
const BACKTEST_DAYS = Number(process.env.FORECAST_DAYS ?? 60);
const TOP_N = 3;

type Pick = {
  code: string;
  name: string;
  rule: string;
  /** 挑中时能看到的量 */
  basis: { streak: number; volRatio: number; close: number };
};

type Outcome = {
  code: string;
  name: string;
  rule: string;
  /** 次日收盘涨跌幅（相对 T 日收盘） */
  nextPct: number | null;
  /** 次日最高价相对 T 日收盘 */
  nextHighPct: number | null;
  /** 次日开盘买入、收盘卖出（真正能拿到的） */
  nextOpenToClose: number | null;
  limitUp: boolean;
  /** 方向命中：次日收盘 > 0 */
  hit: boolean;
  /** 追买成立：次日开盘买入后，盘中最高仍为正 */
  chase: boolean;
};

type Period = {
  date: string;
  nextDate: string | null;
  /** 落档时刻。口径回算的期次没有这一项——它不是当晚发的 */
  lockedAt?: string;
  source: "locked" | "backtest";
  picks: Pick[];
  outcomes?: Outcome[];
  summary?: { hits: number; chases: number; n: number; limitUps: number };
};

function limitOf(code: string): number {
  return limitPct(code);
}

/** 某只票在某天的涨跌幅（相对前一根收盘）。 */
function pctAt(bars: Bar[], i: number): number | null {
  if (i <= 0) return null;
  const prev = bars[i - 1].c;
  if (!prev) return null;
  return bars[i].c / prev - 1;
}

/** 连板数：从第 i 根往前数，连续达到涨停阈值的根数。 */
function streakAt(bars: Bar[], i: number, code: string): number {
  const lim = limitOf(code);
  let n = 0;
  for (let k = i; k >= 1; k -= 1) {
    const p = pctAt(bars, k);
    if (p != null && p >= lim) n += 1;
    else break;
  }
  return n;
}

/** 放量倍数：当日量 ÷ 前 5 日均量。 */
function volRatioAt(bars: Bar[], i: number): number {
  if (i < 5) return 0;
  let sum = 0;
  for (let k = i - 5; k < i; k += 1) sum += bars[k].v;
  const avg = sum / 5;
  return avg > 0 ? bars[i].v / avg : 0;
}

/** 某一天的全市场「涨停票」清单（K 线口径，阈值近似，会在页面上说明）。 */
function dayLimitUps(all: Map<string, Bar[]>, date: string) {
  const rows: { code: string; name: string; streak: number; volRatio: number; close: number }[] = [];
  for (const [code, bars] of all) {
    const i = bars.findIndex((b) => b.date === date);
    if (i <= 0) continue;
    const p = pctAt(bars, i);
    if (p == null || p < limitOf(code)) continue;
    const q = nameOf(code);
    rows.push({ code, name: q, streak: streakAt(bars, i, code), volRatio: volRatioAt(bars, i), close: bars[i].c });
  }
  return rows;
}

let uni: Map<string, string> | null = null;
function nameOf(code: string): string {
  if (!uni) {
    const raw = JSON.parse(readFileSync("data/universe-cache.json", "utf8")) as {
      payload: { quotes: { id: string; name: string }[] };
    };
    uni = new Map(raw.payload.quotes.map((q) => [q.id, q.name]));
  }
  return uni.get(code) ?? code;
}

/** 从一天的涨停清单里按三条固定规则挑 3 只。 */
function pickOf(rows: { code: string; name: string; streak: number; volRatio: number; close: number }[]): Pick[] {
  const byStreak = [...rows].sort((a, b) => b.streak - a.streak || b.volRatio - a.volRatio);
  const picks: Pick[] = [];
  const used = new Set<string>();

  const take = (cand: typeof rows[number] | undefined, rule: string) => {
    if (!cand || used.has(cand.code)) return;
    used.add(cand.code);
    picks.push({ code: cand.code, name: cand.name, rule, basis: { streak: cand.streak, volRatio: cand.volRatio, close: cand.close } });
  };

  take(byStreak[0], "最高板");
  const secondStreak = byStreak[0] ? byStreak[0].streak : 0;
  take(byStreak.find((r) => r.streak < secondStreak), "次高板");
  const firsts = rows.filter((r) => r.streak === 1).sort((a, b) => b.volRatio - a.volRatio);
  take(firsts[0], "首板放量王");

  return picks;
}

/** 用次日真实 K 线结算一期。 */
function settle(all: Map<string, Bar[]>, p: Period): Period {
  const outcomes: Outcome[] = [];
  for (const pick of p.picks) {
    const bars = all.get(pick.code);
    const t = bars?.find((b) => b.date === p.date);
    const nx = bars ? barAfter(bars, p.date, 1) : null;
    if (!bars || !t || !nx) {
      outcomes.push({
        code: pick.code,
        name: pick.name,
        rule: pick.rule,
        nextPct: null,
        nextHighPct: null,
        nextOpenToClose: null,
        limitUp: false,
        hit: false,
        chase: false,
      });
      continue;
    }
    const nextPct = nx.c / t.c - 1;
    const nextHighPct = nx.h / t.c - 1;
    const openToClose = nx.o > 0 ? nx.c / nx.o - 1 : null;
    outcomes.push({
      code: pick.code,
      name: pick.name,
      rule: pick.rule,
      nextPct,
      nextHighPct,
      nextOpenToClose: openToClose,
      limitUp: nextPct >= limitOf(pick.code),
      hit: nextPct > 0,
      // 「追买」= 次日开盘买入，盘中最高仍高于开盘价。用最高价对开盘价比，不是对昨收。
      chase: nx.o > 0 && nx.h > nx.o,
    });
  }
  const valid = outcomes.filter((o) => o.nextPct != null);
  return {
    ...p,
    nextDate: p.picks.length ? (all.get(p.picks[0].code)?.find((b) => b.date > p.date)?.date ?? null) : null,
    outcomes,
    summary: {
      hits: valid.filter((o) => o.hit).length,
      chases: valid.filter((o) => o.chase).length,
      n: valid.length,
      limitUps: valid.filter((o) => o.limitUp).length,
    },
  };
}

function logToday() {
  const poolFile = "data/signals/limit-pools-today.json";
  if (!existsSync(poolFile)) {
    console.log("[forecast] 今天的涨停池还没采，先不落档。");
    return;
  }
  const pool = JSON.parse(readFileSync(poolFile, "utf8")) as {
    date: string;
    sealed: boolean;
    limitUp: { id: string; code: string; name: string; streak: number; sealFund: number; price: number }[];
  };
  if (!pool.sealed) {
    console.log("[forecast] 今天还没收盘封印，不落档（盘中落的档等于事后改口）。");
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const target = join(OUT, `${pool.date}.json`);
  if (existsSync(target)) {
    console.log(`[forecast] ${pool.date} 已落过档，不覆盖（改口就是作弊）。`);
    return;
  }
  // 落档版的放量倍数拿不到（池子里没有量），用封单额代替排序依据；
  // outcomes 结算时仍然只认 K 线，不受影响。
  const rows = pool.limitUp.map((r, i) => ({
    code: r.id,
    name: r.name.replace(/\s+/g, ""),
    streak: r.streak ?? 1,
    // 池子里没有成交量，用封单额的秩当替代排序键，并如实标在 basis 里
    volRatio: r.sealFund ?? i,
    close: r.price,
  }));
  const picks = pickOf(rows);
  const period: Period = {
    date: pool.date,
    nextDate: null,
    lockedAt: new Date().toISOString(),
    source: "locked",
    picks,
  };
  writeFileSync(target, JSON.stringify(period, null, 2));
  console.log(`[forecast] ${pool.date} 落档 ${picks.length} 只（lockedAt ${period.lockedAt}）`);
  for (const p of picks) console.log(`   ${p.name} ${p.code} · ${p.rule} · ${p.basis.streak}板 · 封单 ${(p.basis.volRatio / 1e8).toFixed(2)}亿`);
}

function backtest(all: Map<string, Bar[]>) {
  const dates = tradingDates(all);
  const keep = dates.slice(-BACKTEST_DAYS - 1);
  const periods: Period[] = [];
  // 基准：同期全市场「次日收盘涨」和「次日最高>开盘」的比例。
  // 没有这个基准，53% 的命中率没法判断是本事还是硬币——这是本节唯一有意义的对照。
  let baseUp = 0;
  let baseChase = 0;
  let baseN = 0;
  for (let i = 0; i < keep.length - 1; i += 1) {
    const d = keep[i];
    const rows = dayLimitUps(all, d);
    if (rows.length < 10) continue;
    const picks = pickOf(rows);
    if (picks.length === 0) continue;
    periods.push(settle(all, { date: d, nextDate: null, source: "backtest", picks }));

    // 同一天的全市场基准：所有当天有次日的票都算进去
    for (const [, bars] of all) {
      const idx = bars.findIndex((b) => b.date === d);
      if (idx < 1) continue;
      const t = bars[idx];
      const nx = bars[idx + 1];
      if (!nx) continue;
      baseN += 1;
      if (nx.c > t.c) baseUp += 1;
      if (nx.h > nx.o) baseChase += 1;
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "backtest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        days: BACKTEST_DAYS,
        note: "事后重算：用同一套规则在过去的日子重跑，不是当时发布的清单，不能当成对外战绩",
        baseline: {
          n: baseN,
          upRate: baseN ? baseUp / baseN : null,
          chaseRate: baseN ? baseChase / baseN : null,
        },
        periods,
      },
      null,
      0,
    ),
  );
  const allN = periods.reduce((s, p) => s + (p.summary?.n ?? 0), 0);
  const hits = periods.reduce((s, p) => s + (p.summary?.hits ?? 0), 0);
  const chases = periods.reduce((s, p) => s + (p.summary?.chases ?? 0), 0);
  const lim = periods.reduce((s, p) => s + (p.summary?.limitUps ?? 0), 0);
  console.log(
    `[forecast:backtest] ${periods.length} 期 / ${allN} 笔 · 方向命中 ${((hits / Math.max(1, allN)) * 100).toFixed(1)}% (${hits}) · 追买成立 ${((chases / Math.max(1, allN)) * 100).toFixed(1)}% (${chases}) · 次日涨停 ${((lim / Math.max(1, allN)) * 100).toFixed(1)}% (${lim})`,
  );
}

function verify(all: Map<string, Bar[]>) {
  const files = readdirSync(OUT).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let n = 0;
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(OUT, f), "utf8")) as Period;
    const done = settle(all, p);
    // 只有真的能结算（有次日 K 线）才回写，否则留着等明天
    if (done.summary && done.summary.n > 0) {
      writeFileSync(join(OUT, f), JSON.stringify(done, null, 2));
      n += 1;
    }
  }
  console.log(`[forecast] 回验 ${n} 期`);
}

const mode = process.argv[2] ?? "--log";
const all = loadAllKlines();
if (mode === "--backtest") backtest(all);
else {
  logToday();
  verify(all);
}
