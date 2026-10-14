/**
 * 这个文件是干什么的：
 * 交易日历 + 「持仓哪天到期」的推算（日历页 P3 的核心）。
 *
 * 为什么需要它：账本里一笔持仓记的是「买入日 + 持有 N 个交易日」，想知道它在
 * 哪一天到期，必须知道哪些天是交易日——**而且是未来的交易日**。K 线只有过去的
 * 日期，推不出来，所以要单独拉一份交易日历（scripts/fetch-calendar.py）。
 *
 * 你需要知道的（都是踩过的或会踩的）：
 * 1. **baostock 的交易日历只到当年 12-31**。跨年的到期日算不出来 → 返回 null
 *    让页面写缺口，**不许拿 12-31 冒充**（那会让人以为所有跨年持仓都在年底到期）。
 * 2. **到期日是「计划卖出日」，不是承诺**。中途碰到止损止盈会提前卖，所以日历上
 *    的到期日只能说「如果没提前触发，这天到期」。
 * 3. 数交易日**从买入日的下一根开始**（T+1），和 exitFill 的口径一致——
 *    买入当天不算一天。这里数错一天，日历和账本就会对不上。
 * 4. 纯函数，不碰 fs。日历文件由调用方读进来传参。
 */

/** 交易日历。tradingDays 升序、YYYY-MM-DD。 */
export type TradeCalendar = {
  fetchedAt: string;
  /** 实际拿到的日期范围 */
  range: [string, string] | [];
  tradingDays: string[];
};

export type DueEvent = {
  /** 到期日（第 hold 个交易日） */
  date: string;
  /** 账本里建仓的那天 */
  buyDate: string;
  id: string;
  name: string;
  style: string;
  hold: number;
  /** 买入价，页面上给个参照（不是盈亏） */
  entry: number;
};

export type CalendarView = {
  /** 未来的到期事件，按日期升序 */
  events: DueEvent[];
  /**
   * **已经过了计划到期日、但账本里还是未平仓**的。
   * 这些不是「即将到期」，而是该结没结——要么卡住了（K 线里没有买入日），
   * 要么行情拉不下来没结算。记账进程会把它们记成 stuck 并打日志，但记账进程
   * 只在收盘后跑，日历要在收盘前就把它们摆出来。
   */
  overdue: DueEvent[];
  /** 未来 14 个交易日的条子（含没有事件的空天） */
  timeline: { date: string; events: DueEvent[] }[];
  /** 日历文件的实际范围（页面要写清，别让人以为能算到明年） */
  rangeEnd: string | null;
  gaps: string[];
};

/** 校验一份交易日历。结构不对要说清，不能当「零交易日」放过去。 */
export function checkCalendar(value: unknown): { ok: true; calendar: TradeCalendar } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "交易日历不是对象" };
  const v = value as Partial<TradeCalendar>;
  if (typeof v.fetchedAt !== "string" || v.fetchedAt === "") return { ok: false, reason: "交易日历缺 fetchedAt" };
  if (!Array.isArray(v.tradingDays) || v.tradingDays.length === 0) return { ok: false, reason: "交易日历缺交易日列表" };
  return { ok: true, calendar: v as TradeCalendar };
}

/**
 * 从买入日往后数 n 个交易日的那一天。
 * 买入当天不算（T+1，和 exitFill 同一口径）。数不够（日历没覆盖到）→ null。
 */
export function nthTradingDay(calendar: TradeCalendar, fromDate: string, n: number): string | null {
  if (!(n > 0)) return null;
  const days = calendar.tradingDays;
  const start = days.findIndex((d) => d > fromDate);
  // 买入日当天不是交易日（比如周末补记）就从它之后第一个交易日算起
  if (start < 0) return null;
  const idx = start + n - 1;
  return idx < days.length ? days[idx]! : null;
}

/** 一笔持仓的到期日。算不出（跨年 / 日历没覆盖）返回 null，由调用方写缺口。 */
export function dueDateOf(calendar: TradeCalendar, buyDate: string, hold: number): string | null {
  return nthTradingDay(calendar, buyDate, hold);
}

export type OpenTrade = {
  id: string;
  name: string;
  style: string;
  entry: number;
  hold: number | null;
  buyDate: string;
};

/**
 * 把未平仓持仓摊到日历上。
 * hold 缺省用 defaultHold（和记账进程一致）；算不出到期日的进 gap，不出现在时间线上。
 */
export function calendarView(
  calendar: TradeCalendar | null,
  trades: readonly OpenTrade[],
  today: string,
  defaultHold: number,
  windowDays = 14,
): CalendarView {
  const gaps: string[] = [];
  if (!calendar) {
    gaps.push("交易日历没抓过（跑 python3 scripts/fetch-calendar.py），到期日算不出来");
    return { events: [], overdue: [], timeline: [], rangeEnd: null, gaps };
  }
  const events: DueEvent[] = [];
  const overdue: DueEvent[] = [];
  let undated = 0;
  for (const trade of trades) {
    const hold = trade.hold ?? defaultHold;
    const date = dueDateOf(calendar, trade.buyDate, hold);
    if (!date) {
      undated += 1;
      continue;
    }
    const event: DueEvent = { date, buyDate: trade.buyDate, id: trade.id, name: trade.name, style: trade.style, hold, entry: trade.entry };
    // 到期日已经过去还没结 = 该结没结，分出来单放（今天的算今天到期，不算逾期）
    if (date < today) overdue.push(event);
    else events.push(event);
  }
  if (undated > 0) {
    gaps.push(`${undated} 笔的到期日超出了日历范围（日历给到 ${calendar.range[1] ?? "无"}），算不出来`);
  }
  if (overdue.length > 0) {
    gaps.push(`${overdue.length} 笔已过计划到期日仍未平仓——该结没结。记账进程会在收盘后把它们记成结算不出来并打日志，先来这里看是哪几笔`);
  }
  const byDate = (a: DueEvent, b: DueEvent) => (a.date === b.date ? a.name.localeCompare(b.name, "zh") : a.date < b.date ? -1 : 1);
  events.sort(byDate);
  overdue.sort(byDate);

  const upcoming = calendar.tradingDays.filter((d) => d >= today).slice(0, windowDays);
  const timeline = upcoming.map((date) => ({ date, events: events.filter((e) => e.date === date) }));
  const rangeEnd = calendar.range[1] ?? null;
  // 时间线明明有位置却一笔到期都没有——多半是日历没覆盖到，说一声
  if (timeline.length > 0 && events.length === 0 && trades.length > 0) {
    gaps.push("这些持仓的到期日都不在日历范围内（日历可能过期了，重跑一下抓取脚本）");
  }
  return { events, overdue, timeline, rangeEnd, gaps };
}
