/**
 * 这个文件是干什么的：
 * 事件研究（A2，对标 Vibe-Research 的 `backtest/event_study.py`，702 行）。
 *
 * 它的用途（原文）：选一类事件，把这只股票历史上的每一次排出来，看事件前 5 个交易日
 * 到后 20 个交易日、**相对对照指数的累计超额收益**（每日个股涨跌减指数涨跌再累加）。
 * 这让「这个催化剂历史上管不管用」从定性变定量。
 *
 * 口径逐字对齐（可交叉验证）：
 *   - PRE=5（事件前 5 日）、POST=20（事件后 20 日）
 *   - 第 0 天 = 事件日当天或之后的第一个交易日
 *   - 超额 = 个股日涨跌 − 指数日涨跌，逐日累加
 *   - 汇总档位：pre（前 5 日）/ d0_1 / d0_5 / d0_20
 *   - A 股对照沪深300
 *
 * 三条纪律（照它原文，🔴 标的是命脉）：
 *   1. **事件少于 8 次只列逐次结果，不给平均值**——几次的平均说明不了什么。
 *   2. **窗口里有停牌的照列，但不停牌的才进平均**（复牌那天的涨跌会被算进窗口）；
 *      最近的事件还没满 20 个交易日的，只进已经有的那几档。
 *   3. **只描述这只股票过去的情况，不预测这一次**，不给买卖提示。
 */

import type { KlineRow } from "./indicators.ts";

/** 事件前 5 个交易日。 */
export const EVENT_PRE = 5;
/** 事件后 20 个交易日。 */
export const EVENT_POST = 20;
/** 少于这么多次只列逐次，不给平均（它 MIN_EVENTS）。 */
export const EVENT_MIN = 8;

/** 一次事件（日期 + 说明；direction 用于分组，如增持/减持）。 */
export type StudyEvent = {
  /** 事件日（YYYY-MM-DD） */
  date: string;
  label: string;
  direction?: string;
};

/** 一次事件的窗口结果。 */
export type EventWindow = {
  /** 第 0 天（事件日当天或之后第一个交易日） */
  day0: string;
  /** 各档位累计超额（小数，0.02 = 2%）。null = 没满那一档 */
  pre: number | null;
  d0_1: number | null;
  d0_5: number | null;
  d0_20: number | null;
  /** 窗口内停牌天数（>0 不进平均） */
  haltedDays: number;
  /** 从事件前第 5 日起的累计超额路径（画图用） */
  path: number[];
  label: string;
  direction?: string;
  /** 算不了的原因（进缺口） */
  skip?: string;
};

export type EventStudy = {
  windows: EventWindow[];
  /** 平均只在 ≥ EVENT_MIN 次且无停牌时给，否则 null */
  summary: { n: number; pre: number | null; d0_1: number | null; d0_5: number | null; d0_20: number | null; positiveShare: number | null } | null;
  /** 逐次结果（永远给，哪怕不足 8 次） */
  listed: number;
  gaps: string[];
};

/** 在指数交易日历里找事件日当天或之后的第一个交易日。 */
function firstTradingDayOnOrAfter(cal: readonly string[], day: string): number {
  let lo = 0;
  let hi = cal.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal[mid]! < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pct(series: readonly number[]): number[] {
  const out = [0];
  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1]!;
    out.push(prev > 0 ? series[i]! / prev - 1 : 0);
  }
  return out;
}

/**
 * 算一组事件的超额收益。stock/index 都必须是**按日期升序**的 K 线。
 *
 * 算不了的事件进 windows[].skip 和 gaps（上市前、事件后没有交易日等），不静默丢。
 */
export function studyEvents(
  events: readonly StudyEvent[],
  stock: readonly KlineRow[],
  index: readonly KlineRow[],
): EventStudy {
  const gaps: string[] = [];
  const windows: EventWindow[] = [];
  const cal = index.map((r) => r.date);
  const stockByDate = new Map(stock.map((r) => [r.date, r.close]));

  for (const ev of events) {
    const k = firstTradingDayOnOrAfter(cal, ev.date);
    if (k >= cal.length) {
      windows.push({ day0: "", pre: null, d0_1: null, d0_5: null, d0_20: null, haltedDays: 0, path: [], label: ev.label, direction: ev.direction, skip: "事件之后还没有交易日的价格" });
      gaps.push(`${ev.label}（${ev.date}）：事件之后没有交易日，算不了`);
      continue;
    }
    const base = k - EVENT_PRE - 1;
    if (base < 0) {
      windows.push({ day0: cal[k]!, pre: null, d0_1: null, d0_5: null, d0_20: null, haltedDays: 0, path: [], label: ev.label, direction: ev.direction, skip: `指数在事件前不够 ${EVENT_PRE + 1} 个交易日` });
      gaps.push(`${ev.label}（${ev.date}）：事件前指数数据不够，算不了`);
      continue;
    }
    const end = Math.min(k + EVENT_POST, cal.length - 1);
    const days = cal.slice(base, end + 1);

    // 停牌检测：窗口内个股没有价格的交易日（含起算那天）
    let haltedDays = 0;
    for (const d of days) if (!stockByDate.has(d)) haltedDays += 1;
    if (haltedDays > 0) {
      gaps.push(`${ev.label}（${ev.date}）：窗口内有 ${haltedDays} 天个股无价格（多半停牌），这次不进平均`);
    }

    // 个股序列按窗口日前向填充（停牌日用最近的有价日价格，pct_change 自然是 0）
    const stockSeries: number[] = [];
    let last = stockByDate.get(days[0]!) ?? 0;
    for (const d of days) {
      const v = stockByDate.get(d);
      if (v != null) last = v;
      stockSeries.push(last);
    }
    const indexSeries = days.map((d) => index.find((r) => r.date === d)?.close ?? 0);

    const stockPct = pct(stockSeries);
    const indexPct = pct(indexSeries);
    const daily = stockPct.map((v, i) => v - indexPct[i]!);

    // offsets: 窗口第 0 个是「事件前第 5 日」，事件前第 1 日在索引 EVENT_PRE 处，
    // 第 0 天（事件日或之后首个交易日）在索引 EVENT_PRE + 1 处。
    const dayZeroIdx = EVENT_PRE + 1;
    const sum = (a: number, b: number): number | null => {
      if (b >= daily.length) return null; // 没满那一档
      let s = 0;
      for (let i = a; i <= b; i += 1) s += daily[i] ?? 0;
      return s;
    };
    const pre = sum(0, EVENT_PRE - 1);
    const d0_1 = sum(dayZeroIdx, dayZeroIdx + 1);
    const d0_5 = sum(dayZeroIdx, dayZeroIdx + 5);
    const d0_20 = sum(dayZeroIdx, dayZeroIdx + EVENT_POST);

    // 累计路径（从事件前第 5 日起）
    const path: number[] = [];
    let acc = 0;
    for (let i = 0; i < daily.length; i += 1) {
      acc += daily[i] ?? 0;
      path.push(acc);
    }

    windows.push({
      day0: cal[k]!,
      pre,
      d0_1,
      d0_5,
      d0_20,
      haltedDays,
      path,
      label: ev.label,
      direction: ev.direction,
    });
  }

  // 平均：只有「无停牌」的进；不足 EVENT_MIN 次不给平均
  const clean = windows.filter((w) => !w.skip && w.haltedDays === 0);
  let summary: EventStudy["summary"] = null;
  if (clean.length >= EVENT_MIN) {
    const mean = (pick: (w: EventWindow) => number | null): number | null => {
      const vals = clean.map(pick).filter((v): v is number => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    };
    const positives = clean.map((w) => w.d0_20).filter((v): v is number => v != null);
    summary = {
      n: clean.length,
      pre: mean((w) => w.pre),
      d0_1: mean((w) => w.d0_1),
      d0_5: mean((w) => w.d0_5),
      d0_20: mean((w) => w.d0_20),
      positiveShare: positives.length > 0 ? positives.filter((v) => v > 0).length / positives.length : null,
    };
  } else {
    gaps.push(`有效事件只有 ${clean.length} 次（少于 ${EVENT_MIN}），按纪律只列逐次结果、不给平均值`);
  }

  return { windows, summary, listed: windows.filter((w) => !w.skip).length, gaps };
}
