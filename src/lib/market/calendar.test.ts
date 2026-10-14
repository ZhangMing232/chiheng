/**
 * 这个文件是干什么的：
 * 钉住日历推算的口径——数错一天，日历就和账本对不上。
 *
 * 重点：
 * 1. 数交易日从买入日的**下一天**开始（T+1，和 exitFill 一致）
 * 2. 跨年（超出日历范围）算不出就返回 null，不许拿最后一天冒充
 * 3. 日历文件没抓过/结构坏 → 写缺口，不出空时间线装作没事
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarView, checkCalendar, dueDateOf, nthTradingDay, type TradeCalendar } from "@/lib/market/calendar";

const cal: TradeCalendar = {
  fetchedAt: "2026-10-14",
  range: ["2026-09-04", "2026-12-31"],
  // 2026-10-09 是周五；10-10/10-11 周末；10-12 起是周一
  tradingDays: ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"],
};

test("数交易日从买入日的下一天开始（T+1）", () => {
  assert.equal(nthTradingDay(cal, "2026-10-08", 1), "2026-10-09", "第 1 个交易日是次日");
  assert.equal(nthTradingDay(cal, "2026-10-08", 2), "2026-10-12", "跳过周末");
  assert.equal(nthTradingDay(cal, "2026-10-08", 5), "2026-10-15");
});

test("买入日不是交易日也能数（周末补记的仓）", () => {
  assert.equal(nthTradingDay(cal, "2026-10-10", 1), "2026-10-12");
});

test("数超出日历范围返回 null，不拿最后一天冒充", () => {
  assert.equal(nthTradingDay(cal, "2026-10-08", 99), null, "日历只到 10-16，不能拿它顶替");
  assert.equal(dueDateOf(cal, "2026-10-08", 99), null);
});

test("hold 不合法就别数", () => {
  assert.equal(dueDateOf(cal, "2026-10-08", 0), null);
  assert.equal(dueDateOf(cal, "2026-10-08", -1), null);
});

test("日历文件校验：缺交易日或结构坏都要出声", () => {
  assert.equal(checkCalendar(cal).ok, true);
  assert.equal(checkCalendar(null).ok, false);
  assert.equal(checkCalendar({ ...cal, tradingDays: [] }).ok, false);
  assert.equal(checkCalendar({ ...cal, fetchedAt: "" }).ok, false);
  assert.equal(checkCalendar([1, 2]).ok, false, "数组不算对象");
});

test("日历没抓过：写缺口，不给空时间线装没事", () => {
  const v = calendarView(null, [{ id: "sh1", name: "甲", style: "rebound", entry: 10, hold: 8, buyDate: "2026-10-08" }], "2026-10-14", 8);
  assert.equal(v.events.length, 0);
  assert.equal(v.overdue.length, 0);
  assert.equal(v.timeline.length, 0);
  assert.ok(v.gaps.some((g) => g.includes("交易日历没抓过")));
});

test("已过到期日仍未平仓的分出来单放，并写进缺口", () => {
  // 建仓 10-08：hold 1 → 到期 10-09（已过 5 天，该结没结）
  // hold 4 → 到期 10-14（就是今天，不算逾期）
  const trades = [
    { id: "sh1", name: "甲", style: "rebound", entry: 10, hold: 1, buyDate: "2026-10-08" },
    { id: "sh2", name: "乙", style: "breakout", entry: 20, hold: 4, buyDate: "2026-10-08" },
  ];
  const v = calendarView(cal, trades, "2026-10-14", 8);
  assert.deepEqual(v.overdue.map((e) => e.name), ["甲"], "甲到期日 10-09 已过");
  assert.ok(!v.events.some((e) => e.name === "甲"), "逾期的不再出现在未来时间线里");
  assert.deepEqual(v.events.map((e) => e.name), ["乙"], "乙今天到期");
  assert.ok(v.gaps.some((g) => g.includes("已过计划到期日仍未平仓")));
});

test("今天/未来到期的都不算逾期", () => {
  // 建仓 10-09（周五），hold 2 → 数 10-12（1）、10-13（2）→ 到期 10-13
  const trades = [{ id: "sh1", name: "甲", style: "rebound", entry: 10, hold: 2, buyDate: "2026-10-09" }];
  const v = calendarView(cal, trades, "2026-10-12", 8);
  assert.equal(v.events[0]?.date, "2026-10-13");
  assert.equal(v.overdue.length, 0);
});

test("持仓摊到时间线上，同一天多笔合并", () => {
  const trades = [
    { id: "sh1", name: "甲", style: "rebound", entry: 10, hold: 2, buyDate: "2026-10-08" },
    { id: "sh2", name: "乙", style: "breakout", entry: 20, hold: 2, buyDate: "2026-10-08" },
    { id: "sh3", name: "丙", style: "rebound", entry: 30, hold: null, buyDate: "2026-10-09" },
  ];
  const v = calendarView(cal, trades, "2026-10-12", 8);
  const day12 = v.timeline.find((t) => t.date === "2026-10-12")!;
  assert.equal(day12.events.length, 2, "甲乙都在 10-12 到期（hold=2）");
  // 丙没给 hold，用默认 8 天：从 10-09 数第 8 个交易日 → 超出日历 → 进 gap
  assert.ok(v.gaps.some((g) => g.includes("超出了日历范围")));
});

test("时间线只给未来的交易日，且不含已经过去的天", () => {
  const v = calendarView(cal, [], "2026-10-13", 8, 3);
  assert.deepEqual(v.timeline.map((t) => t.date), ["2026-10-13", "2026-10-14", "2026-10-15"]);
});

test("rangeEnd 原样带出来，页面要写清日历给到哪天", () => {
  const v = calendarView(cal, [], "2026-10-13", 8);
  assert.equal(v.rangeEnd, "2026-12-31");
});
