/**
 * 这个文件是干什么的：
 * 只认上海时间，判断今天是不是交易日、现在是早盘、午休还是尾盘。
 *
 * 你需要知道的：
 * 买入窗口只有两段：9:25 到 9:30，以及 14:40 到 15:00。
 * 次日补涨要等到 14:30 之后才冻结名单，之前看到的价格只是预览。
 * 节假日写在 HOLIDAYS 里，只覆盖到 2027 年。写进去的年份过完后要手工补下一年，
 * 否则假日会被当成交易日，届时会拿着休市前的旧快照记下并不存在的成交。
 * 2027 年的日期是推算的，官方通知发布后需要回来核对。
 */
import type { SessionInfo } from "@/lib/market/types";

const HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-23",
  "2026-04-06",
  "2026-05-01",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01",
  "2026-10-02",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  // 2027 年：按《全国年节及纪念日放假办法》和 2027 年的农历推算出来的。
  // 国务院办公厅一般在上一年的 11 月前后才发布次年具体的放假调休通知，
  // 通知发布后要回来核对一遍，尤其是春节和劳动节——这两处的拼接方式最容易变。
  // 只写工作日：周末本来就不交易，写进来没有意义。
  "2027-01-01", // 元旦
  "2027-02-05", // 除夕（自 2025 年起纳入法定假日）
  "2027-02-08", // 春节初三；初四至初六，除夕逢周五时连休可达 9 天
  "2027-02-09",
  "2027-02-10",
  "2027-02-11",
  "2027-02-12",
  "2027-04-05", // 清明，周一，与前后周末连休三天
  "2027-05-03", // 劳动节，法定 5/1、5/2 恰逢周末，调休五天
  "2027-05-04",
  "2027-05-05",
  "2027-06-09", // 端午，周三，只在当天
  "2027-09-15", // 中秋，周三，只在当天
  "2027-10-01", // 国庆，周五，自 10/1 起调休七天
  "2027-10-04",
  "2027-10-05",
  "2027-10-06",
  "2027-10-07",
]);

/** 周末和 HOLIDAYS 里的日期都不是交易日。weekday 不传就按上海时区自己算。 */
export function isTradingDay(date: string, weekday?: string): boolean {
  if (HOLIDAYS.has(date)) return false;
  if (weekday === "Sat" || weekday === "Sun") return false;
  const day =
    weekday ??
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(
      new Date(`${date}T12:00:00+08:00`),
    );
  return day !== "Sat" && day !== "Sun";
}

function shanghaiParts(now: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: pick("weekday"),
    mins: Number(pick("hour")) * 60 + Number(pick("minute")),
    month: pick("month"),
    day: pick("day"),
  };
}

/** 下一个交易日，写成「9月30日」。用来提示最早哪天能卖。 */
export function nextSessionLabel(now = Date.now()): string {
  let cursor = now + 24 * 60 * 60 * 1000;
  for (let i = 0; i < 16; i += 1) {
    const { weekday, month, day } = shanghaiParts(cursor);
    if (isTradingDay(shanghaiDate(cursor), weekday)) {
      return `${Number(month)}月${Number(day)}日`;
    }
    cursor += 24 * 60 * 60 * 1000;
  }
  return "下一交易日";
}

/** 当前时刻在上海是哪一天，格式 YYYY-MM-DD。不要用电脑本地时区。 */
export function shanghaiDate(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function entryOf(date: string, weekday: string, mins: number): "none" | "open" | "close" {
  if (!isTradingDay(date, weekday)) return "none";
  if (mins >= 9 * 60 + 25 && mins <= 9 * 60 + 30) return "open";
  if (mins >= 14 * 60 + 40 && mins < 15 * 60) return "close";
  return "none";
}

/**
 * 从现在起再过这么多个交易日，是几月几日。
 * 已经收盘或本来就是周末，先跳到下一个交易日再开始数。
 */
export function exitAfterSessions(sessions: number, now = Date.now()): string {
  const target = Math.max(1, Math.round(sessions));
  const start = shanghaiParts(now);
  const weekend = !isTradingDay(shanghaiDate(now), start.weekday);
  let cursor = now;
  if (weekend || start.mins >= 15 * 60) {
    for (let i = 0; i < 12; i += 1) {
      cursor += 24 * 60 * 60 * 1000;
      const part = shanghaiParts(cursor);
      if (isTradingDay(shanghaiDate(cursor), part.weekday)) break;
    }
  }
  let counted = 0;
  for (let i = 0; i < 400 && counted < target; i += 1) {
    cursor += 24 * 60 * 60 * 1000;
    const part = shanghaiParts(cursor);
    if (!isTradingDay(shanghaiDate(cursor), part.weekday)) continue;
    counted += 1;
    if (counted === target) return `${Number(part.month)}月${Number(part.day)}日`;
  }
  return "更晚的交易日";
}

/** 把「现在」翻译成页面上那一行状态：未开盘、集合竞价、交易中、午间休市、尾盘、已收盘。 */
export function sessionPhase(now = Date.now()): SessionInfo {
  const { weekday, mins } = shanghaiParts(now);
  const nextSell = nextSessionLabel(now);
  const date = shanghaiDate(now);
  const holiday = !isTradingDay(date, weekday);
  const sealed = !holiday && mins >= 15 * 60;
  const matching = !holiday && ((mins >= 9 * 60 + 30 && mins < 11 * 60 + 30) || mins >= 13 * 60);
  const tailHalf = !holiday && mins >= 14 * 60 + 30;
  const entry = entryOf(date, weekday, mins);
  const tail = entry === "close";
  const base = { nextSell, date, sealed, entry, tail, matching, tailHalf };
  if (holiday) {
    return { ...base, phase: "closed", label: weekday === "Sat" || weekday === "Sun" ? "周末休市" : "节假日休市", open: false };
  }
  if (mins < 9 * 60 + 15) return { ...base, phase: "pre", label: "未开盘", open: false };
  if (mins < 9 * 60 + 25) return { ...base, phase: "auction", label: "集合竞价", open: true };
  if (mins <= 9 * 60 + 30) return { ...base, phase: "auction", label: "早盘买入时段", open: true };
  if (mins < 11 * 60 + 30) return { ...base, phase: "morning", label: "交易中", open: true };
  if (mins < 13 * 60) return { ...base, phase: "lunch", label: "午间休市", open: false };
  if (mins < 14 * 60 + 40) return { ...base, phase: "afternoon", label: "交易中", open: true };
  if (mins < 15 * 60) return { ...base, phase: "afternoon", label: "尾盘买入时段", open: true };
  return { ...base, phase: "closed", label: "已收盘", open: false };
}

/** 把毫秒时间戳收成上海时间的「时:分」。 */
export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}
