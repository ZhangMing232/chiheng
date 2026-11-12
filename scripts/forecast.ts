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
  // 三个真实价（都是盘后才知道，不含未来函数）
  pickPrice: number | null; // T 日收盘（选股时看到的价格）
  buyPrice: number | null; // T+1 开盘（最早能成交的买入价）
  sellPrice: number | null; // T+1 收盘（结算卖出价）
  highPrice: number | null; // T+1 最高（追买判定）
  tradePct: number | null; // 真实交易盈亏 = sellPrice/buyPrice - 1
  holdPct: number | null; // T 日收盘→T+1 收盘（方向命中的基准口径）
  highPct: number | null; // T+1 最高相对买入价（追买幅度）
  // 旧字段保留作别名，regenerate 后值一致
  nextPct: number | null;
  nextHighPct: number | null;
  nextOpenToClose: number | null;
  limitUp: boolean;
  hit: boolean;
  chase: boolean;
  /** 买入日能不能买到：false = 一字涨停排不进；true = 能；null = 不知道 */
  buyFilled?: boolean | null;
  /** 结算日能不能卖掉：false = 一字跌停卖不出 */
  sellFilled?: boolean | null;
  /** 成交性说明，页面直接显示，不让人自己猜 */
  fillNote?: string | null;
};

type Period = {
  date: string;
  nextDate: string | null;
  /** 落档时刻。口径回算的期次没有这一项——它不是当晚发的 */
  lockedAt?: string;
  source: "locked" | "backtest";
  picks: Pick[];
  outcomes?: Outcome[];
  summary?: { hits: number; chases: number; n: number; limitUps: number; unfilled?: number; stuck?: number };
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

const KLINE_HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" };
const GTIMG_LOOKBACK = 40;

/** 北京时间（实际即时）。返回 Date 的 getUTC* 反映的是北京时刻。 */
function beijingNow(): Date {
  return new Date(Date.now() + 8 * 3600_000);
}

/** 某根 K 线是否已收盘、可结算：
 *  - 日期早于今天 → 一定收完了
 *  - 等于今天 → 只有北京时 ≥15:00 才算收盘（盘中拉到的棒是半截，拿去结算会算错）
 *  - 晚于今天 → 还没发生，跳过 */
function isFinalBar(dateStr: string): boolean {
  const bj = beijingNow();
  const today = bj.toISOString().slice(0, 10);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return bj.getUTCHours() >= 15;
}

/** 从腾讯接口拉某只票最近 N 天日线（含可能未收盘的当天）。 */
async function fetchBarsLive(code: string, lookback = GTIMG_LOOKBACK): Promise<Bar[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},day,,,${lookback}`;
  try {
    const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
    const rows = body.data?.[code]?.day ?? [];
    const out: Bar[] = [];
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
  } catch {
    return [];
  }
}

/** 拉远端、把本地缺的棒补进文件+内存（自修复，下次结算直接读本地）。只在确认要结算时才落盘。 */
async function fetchMergeKline(code: string, all: Map<string, Bar[]>): Promise<void> {
  const live = await fetchBarsLive(code);
  if (live.length === 0) return;
  const existing = all.get(code) ?? [];
  const have = new Set(existing.map((b) => b.date));
  const merged = [...existing];
  for (const b of live) if (!have.has(b.date)) { merged.push(b); have.add(b.date); }
  merged.sort((a, b) => (a.date < b.date ? -1 : 1));
  all.set(code, merged);
  try {
    writeFileSync(`data/backtest/kline/${code}.json`, JSON.stringify(merged));
  } catch {
    // 写盘失败不致命，内存里这份本进程还能用
  }
}

/** 涨跌停价：按板块限幅四舍五入到分。T+1 日的限幅基于 T 日收盘（t.c）。 */
/**
 * 交易所**真实**涨跌幅（算涨跌停价用）：主板 10%、创业板/科创板 20%、北交所 30%。
 * 别拿 limitPct() 那个 0.095/0.195/0.295——那是「判定涨停」用的近似阈值
 * （留了余量防止四舍五入漏判），拿来算限价会把 25.66 算成 25.55。
 * ST 股实际是 5%，但代码里看不出 ST，这里不吃这一口，遇到 ST 会判偏松。
 */
function limitRatio(code: string): number {
  const bare = code.replace(/^(sh|sz|bj)/, "");
  if (code.startsWith("bj")) return 0.3;
  if (bare.startsWith("300") || bare.startsWith("301") || bare.startsWith("688") || bare.startsWith("689")) return 0.2;
  return 0.1;
}

function limitPrices(code: string, prevClose: number): { up: number; down: number } {
  const p = limitRatio(code);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { up: round2(prevClose * (1 + p)), down: round2(prevClose * (1 - p)) };
}

/**
 * 能不能成交。这是「逻辑对不对」的问题，不是精度问题：
 *   买入日一字涨停（最低价就是涨停价）→ 全天没有低于涨停价的成交，挂单排不进去，买不到。
 *   结算日一字跌停（最高价就是跌停价）→ 全天没有高于跌停价的成交，挂跌停也卖不出。
 * 开盘涨停但盘中开过板 → 能买（成交价多半低于开盘价，所以用开盘价算成本是偏保守的）。
 * 收盘跌停但盘中开过板 → 能卖（卖在跌停价附近，卖出价就用收盘价，是偏保守的）。
 */
function fillCheck(code: string, t: Bar, nx: Bar): { buyFilled: boolean | null; sellFilled: boolean | null; fillNote: string | null } {
  const { up, down } = limitPrices(code, t.c);
  const eps = 0.005;
  const notes: string[] = [];
  let buyFilled: boolean | null = true;
  if (nx.o >= up - eps) {
    if (nx.l >= up - eps) {
      buyFilled = false;
      notes.push(`买入日 ${up.toFixed(2)} 一字涨停，开盘挂单排不进（当天最低就是涨停价）`);
    } else {
      notes.push(`开盘涨停后开板（最低 ${nx.l.toFixed(2)}），能买到，实际成交价低于开盘价`);
    }
  }
  let sellFilled: boolean | null = true;
  if (nx.c <= down + eps) {
    if (nx.h <= down + eps) {
      sellFilled = false;
      notes.push(`结算日 ${down.toFixed(2)} 一字跌停，挂跌停也卖不出（当天最高就是跌停价）`);
    } else {
      notes.push(`收盘跌停（盘中最高 ${nx.h.toFixed(2)}），能卖，卖在跌停价附近`);
    }
  }
  return { buyFilled, sellFilled, fillNote: notes.length ? notes.join("；") : null };
}

/** 纯函数：给定 T 日棒和 T+1 日棒，算一只票的结算结果。两者缺一不可。 */
function computeOutcome(pick: Pick, t: Bar | null, nx: Bar | null): Outcome {
  const base: Outcome = {
    code: pick.code,
    name: pick.name,
    rule: pick.rule,
    pickPrice: t?.c ?? null,
    buyPrice: null,
    sellPrice: null,
    highPrice: null,
    tradePct: null,
    holdPct: null,
    highPct: null,
    nextPct: null,
    nextHighPct: null,
    nextOpenToClose: null,
    limitUp: false,
    hit: false,
    chase: false,
    buyFilled: null,
    sellFilled: null,
    fillNote: null,
  };
  if (!t || !nx) return base;
  const pickPrice = t.c;
  const buyPrice = nx.o;
  const sellPrice = nx.c;
  const highPrice = nx.h;
  const fill = fillCheck(pick.code, t, nx);
  // 买不到 / 卖不出，就没有「这一笔盈亏」——拿一个成交不了的价算收益就是假账
  const tradable = fill.buyFilled !== false && fill.sellFilled !== false;
  const tradePct = tradable && buyPrice > 0 ? sellPrice / buyPrice - 1 : null;
  const holdPct = pickPrice > 0 ? sellPrice / pickPrice - 1 : null;
  const highPct = buyPrice > 0 ? highPrice / buyPrice - 1 : null;
  return {
    ...base,
    pickPrice,
    buyPrice,
    sellPrice,
    highPrice,
    tradePct,
    holdPct,
    highPct,
    nextPct: holdPct,
    nextHighPct: highPct,
    nextOpenToClose: tradePct,
    limitUp: holdPct != null && holdPct >= limitOf(pick.code),
    // 方向命中：T 日收盘→T+1 收盘收涨，和全市场基准口径对齐
    hit: (holdPct ?? 0) > 0,
    // 追买：T+1 开盘买入后，盘中最高仍高于开盘价
    chase: buyPrice > 0 && highPrice > buyPrice,
    buyFilled: fill.buyFilled,
    sellFilled: fill.sellFilled,
    fillNote: fill.fillNote,
  };
}

/** 结算一期：本地有的棒直接算（backtest 和已缓存的落档都走这）。 */
function settleLocal(all: Map<string, Bar[]>, p: Period): Period {
  const outcomes: Outcome[] = p.picks.map((pick) => {
    const bars = all.get(pick.code) ?? [];
    const t = bars.find((b) => b.date === p.date) ?? null;
    const nx = barAfter(bars, p.date, 1);
    return computeOutcome(pick, t, nx);
  });
  return finishSettle(p, outcomes, all);
}

/** 结算一期：本地缺 T+1 棒时先调腾讯补数（落档期次日可能还没进本地 kline）。 */
async function settleLive(all: Map<string, Bar[]>, p: Period): Promise<Period> {
  const outcomes: Outcome[] = [];
  for (const pick of p.picks) {
    let bars = all.get(pick.code) ?? [];
    let t = bars.find((b) => b.date === p.date) ?? null;
    let nx = barAfter(bars, p.date, 1);
    if (!t || !nx) {
      await fetchMergeKline(pick.code, all); // 只在这里落盘（verify 已确认 T+1 收盘）
      bars = all.get(pick.code) ?? [];
      t = bars.find((b) => b.date === p.date) ?? null;
      nx = barAfter(bars, p.date, 1);
    }
    outcomes.push(computeOutcome(pick, t, nx));
  }
  return finishSettle(p, outcomes, all);
}

/** 收尾：算 nextDate / summary，只把「真能结算」的写回。 */
function finishSettle(p: Period, outcomes: Outcome[], all: Map<string, Bar[]>): Period {
  // 胜率只统计「真的买得进」的笔；一字涨停排不进的单列 unfilled，卖不出的单列 stuck
  const valid = outcomes.filter((o) => o.nextPct != null && o.buyFilled !== false);
  const unfilled = outcomes.filter((o) => o.buyFilled === false).length;
  const stuck = outcomes.filter((o) => o.buyFilled !== false && o.sellFilled === false).length;
  // nextDate：T 日之后第一个交易日。优先从任意一只票的本地棒里找。
  let nextDate: string | null = null;
  for (const pick of p.picks) {
    const bars = all.get(pick.code);
    if (!bars) continue;
    const nx = barAfter(bars, p.date, 1);
    if (nx) { nextDate = nx.date; break; }
  }
  return {
    ...p,
    nextDate,
    outcomes,
    summary: {
      hits: valid.filter((o) => o.hit).length,
      chases: valid.filter((o) => o.chase).length,
      n: valid.length,
      limitUps: valid.filter((o) => o.limitUp).length,
      unfilled,
      stuck,
    },
  };
}

async function logToday() {
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
  await pushTomorrow(picks, pool.date);
}

/**
 * 落档之后立刻推一条「明天开盘买这 3 只」——这才是「提前收到买入通知」：
 * 收盘后盘面定了才挑得出来，盘中推就是拍脑袋。
 *
 * 通知里必须写死两件事，否则等于骗人去接一字板：
 *   ① 开盘就在涨停价、当天没低过涨停价 = 一字板，挂单排不进 → 放弃，不要追
 *   ② 这套规则 60 天里 8.3% 的笔数根本买不进，命中 49.1% 对基准 46.0%
 * 用 --no-push 可以只打印不推送（排障用）。
 */
async function pushTomorrow(picks: Pick[], day: string) {
  const lines: string[] = [];
  lines.push(`选股日 ${day} 收盘 · 下一个交易日开盘买入、当日收盘结算`);
  lines.push("──────────────────");
  for (const p of picks) {
    lines.push(`${p.rule}｜${p.name} ${p.code}｜选股价 ${p.basis.close}｜${p.basis.streak}板`);
  }
  lines.push("──────────────────");
  lines.push("怎么买：开盘价买。开盘就在涨停价、且当天没低过涨停价＝一字板，挂单排不进，直接放弃，不要追。");
  lines.push("怎么卖：当日收盘卖（这套是隔日口径，不留过夜）。");
  lines.push("诚实提示：60 天 180 笔里 15 笔（8.3%）买不进；方向命中 49.1%，全市场基准 46.0%；追买 87.9% 跑输基准 94.4%。买不到的最强，能买到的更弱。");
  const body = lines.join("\n");
  if (process.argv.includes("--no-push")) {
    console.log("[forecast] --no-push，只打印不推送：");
    console.log(body);
    return;
  }
  try {
    const { sendPushPlus } = await import("../src/lib/market/push.ts");
    const sent = await sendPushPlus(`📌 明日买入单 · 选股日 ${day}`, body, "txt");
    console.log(sent ? "明日买入单已推送微信" : "明日买入单没推出去（没配 token 或被接口拒绝）");
  } catch (e) {
    console.log(`明日买入单推送失败: ${e instanceof Error ? e.message : String(e)}`);
  }
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
    periods.push(settleLocal(all, { date: d, nextDate: null, source: "backtest", picks }));

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

/** 不写盘地探出某期的 T+1 交易日：本地有就本地取，本地没有就拉一次远端只读、不落盘。 */
async function peekNextDate(p: Period, all: Map<string, Bar[]>): Promise<string | null> {
  for (const pick of p.picks) {
    const bars = all.get(pick.code);
    if (bars) {
      const nx = barAfter(bars, p.date, 1);
      if (nx) return nx.date;
    }
  }
  const probe = p.picks[0];
  if (!probe) return null;
  const live = await fetchBarsLive(probe.code);
  const i = live.findIndex((b) => b.date === p.date);
  if (i < 0 || i + 1 >= live.length) return null;
  return live[i + 1].date;
}

/** 回验所有未结算的落档期：只看「T+1 已收盘」的，没到结算期的留待次日。 */
async function verify(all: Map<string, Bar[]>) {
  const files = readdirSync(OUT).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let settled = 0;
  let pending = 0;
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(OUT, f), "utf8")) as Period;
    if (p.summary && p.summary.n > 0) continue; // 已结算
    const next = await peekNextDate(p, all);
    if (!next) { pending += 1; continue; }
    if (!isFinalBar(next)) { pending += 1; continue; } // T+1 还没收盘，等
    const done = await settleLive(all, p);
    if (done.summary && done.summary.n > 0) {
      writeFileSync(join(OUT, f), JSON.stringify(done, null, 2));
      settled += 1;
    } else {
      pending += 1;
    }
  }
  console.log(`[forecast] 回验 ${settled} 期 · 待结算 ${pending} 期`);
}

async function main() {
  const all = loadAllKlines();
  const mode = process.argv[2] ?? "--log";
  if (mode === "--backtest") {
    backtest(all);
  } else {
    await logToday();
    await verify(all);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
