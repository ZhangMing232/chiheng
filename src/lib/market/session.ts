import type { SessionInfo } from "@/lib/market/types";

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

export function nextSessionLabel(now = Date.now()): string {
  let cursor = now + 24 * 60 * 60 * 1000;
  for (let i = 0; i < 8; i += 1) {
    const { weekday, month, day } = shanghaiParts(cursor);
    if (weekday !== "Sat" && weekday !== "Sun") {
      return `${Number(month)}月${Number(day)}日`;
    }
    cursor += 24 * 60 * 60 * 1000;
  }
  return "下一交易日";
}

export function shanghaiDate(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function entryOf(weekday: string, mins: number): "none" | "open" | "close" {
  if (weekday === "Sat" || weekday === "Sun") return "none";
  if (mins >= 9 * 60 + 25 && mins <= 9 * 60 + 30) return "open";
  if (mins >= 14 * 60 + 40 && mins < 15 * 60) return "close";
  return "none";
}

export function exitAfterSessions(sessions: number, now = Date.now()): string {
  const target = Math.max(1, Math.round(sessions));
  const start = shanghaiParts(now);
  const weekend = start.weekday === "Sat" || start.weekday === "Sun";
  let cursor = now;
  if (weekend || start.mins >= 15 * 60) {
    for (let i = 0; i < 8; i += 1) {
      cursor += 24 * 60 * 60 * 1000;
      const part = shanghaiParts(cursor);
      if (part.weekday !== "Sat" && part.weekday !== "Sun") break;
    }
  }
  let counted = 0;
  for (let i = 0; i < 400 && counted < target; i += 1) {
    cursor += 24 * 60 * 60 * 1000;
    const part = shanghaiParts(cursor);
    if (part.weekday === "Sat" || part.weekday === "Sun") continue;
    counted += 1;
    if (counted === target) return `${Number(part.month)}月${Number(part.day)}日`;
  }
  return "更晚的交易日";
}

export function sessionPhase(now = Date.now()): SessionInfo {
  const { weekday, mins } = shanghaiParts(now);
  const nextSell = nextSessionLabel(now);
  const date = shanghaiDate(now);
  const sealed = weekday !== "Sat" && weekday !== "Sun" && mins >= 15 * 60;
  const entry = entryOf(weekday, mins);
  const tail = entry === "close";
  const base = { nextSell, date, sealed, entry, tail };
  if (weekday === "Sat" || weekday === "Sun") {
    return { ...base, phase: "closed", label: "周末休市", open: false };
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

export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}
