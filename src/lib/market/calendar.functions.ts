/**
 * 这个文件是干什么的：
 * 日历页（/calendar）的服务端接口：读交易日历 + 服务端账本，算出「哪笔哪天到期」。
 *
 * 你需要知道的：
 * - 到期日是**计划卖出日**，不是承诺：中途碰到止损止盈会提前卖。页面必须写这句。
 * - 跨年的到期日算不出来（baostock 只给到当年 12-31）→ 进 gaps，不出假日期。
 * - 算日期的活全在 `calendar.ts`（有单测），这里只负责读文件和转手。
 */

import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { calendarView, checkCalendar, type CalendarView, type TradeCalendar } from "./calendar.ts";
import { HOLD_SESSIONS } from "./model.ts";
import { STYLES } from "./strategies.ts";
import type { PaperDay } from "@/lib/paper";

// 纯字符串拼接，不用 node:path 的 join：本文件是 server fn 模块会进客户端 bundle，
// 浏览器里 node:path 是空壳，模块顶层调用 join 会让整站 JS 一启动就崩（2026-10-16 修过）。
const CALENDAR_PATH = "data/backtest/calendar.json";

export type CalendarPayload = {
  view: CalendarView;
  /** 未平仓的笔数（页面用来区分「没持仓」和「算不出」） */
  open: number;
  today: string;
};

/** 交易日历。没抓过 / 结构不对 → null，页面写缺口。 */
export async function loadCalendar(root = process.cwd()): Promise<TradeCalendar | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, CALENDAR_PATH), "utf-8"));
    const checked = checkCalendar(parsed);
    return checked.ok ? checked.calendar : null;
  } catch {
    return null;
  }
}

/**
 * 日历页的数据。账本由页面传进来（它已经在 loader 里拉过服务端账本了，
 * 不重复拉一次）。
 */
export const getCalendar = createServerFn({ method: "GET" })
  .validator((input: unknown): { days: PaperDay[] } => {
    const days = (input as { days?: unknown })?.days;
    return { days: Array.isArray(days) ? (days as PaperDay[]) : [] };
  })
  .handler(async ({ data }): Promise<CalendarPayload> => {
    const calendar = await loadCalendar();
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const open: { id: string; name: string; style: string; entry: number; hold: number | null; buyDate: string }[] = [];
    for (const day of data.days) {
      for (const trade of day.trades ?? []) {
        if (trade.exit != null) continue;
        open.push({
          id: trade.id,
          name: trade.name,
          style: STYLES.find((s) => s.id === trade.style)?.name ?? trade.style ?? "",
          entry: trade.entry,
          hold: trade.hold ?? null,
          buyDate: day.date,
        });
      }
    }
    const view = calendarView(calendar, open, today, HOLD_SESSIONS);
    return { view, open: open.length, today };
  });
