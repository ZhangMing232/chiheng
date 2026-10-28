/**
 * 这个文件是干什么的：
 * 把 A 股交易的硬规矩写成断言，钉死所有「用日 K 算成交」的地方。
 *
 * 四条规矩（2026-10-28 明确立的，破任何一条整本账就是假的）：
 * 1. **T+1**：今天买入的，最早隔一个交易日才能卖。成交日绝不能等于买入日。
 * 2. **不能用买入当天的收盘价卖出**。买入那一刻根本不知道当天收盘是多少，
 *    拿它当卖出价等于凭空给收益（或凭空扣亏损）。
 * 3. **不能看未来**：成交日不能晚于喂进来的最后一根 K 线，也不能凭空返回没有的日期。
 * 4. **这一分钟不知道下一分钟**：没走完的当日 K 线不能参与判定（收盘价、最高最低
 *    价都属于「收盘后才知道」）。
 *
 * 为什么值得单独一个文件：这几条破了不会报错，只会让账上的数字悄悄变好看（或变难看），
 * 事后极难发现——2026-10-28 查出那 10 笔就是最后一根 K 线没走完就结的账，
 * 有一笔本来赚 4.22% 被记成亏 5.28%（见 data/books/PRE-FIX-NOTE.md）。
 * 规则写在注释里没人管，写成断言才会在有人动 exitFill 的时候先炸。
 *
 * 一句话给后来的人：**凡是「拿日 K 算一个成交」，先来这里过一遍。**
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { exitFill } from "@/lib/market/journal-book";
import { intradayFill } from "@/lib/market/intraday-fill";
import { settleOne } from "@/lib/market/settle";
import type { Bar } from "@/lib/market/types";

const bar = (date: string, o: number, c: number, h = Math.max(o, c), l = Math.min(o, c)): Bar => ({
  date,
  o,
  c,
  h,
  l,
  v: 100,
});

const ENTRY_DAY = "2026-03-02";
const base = {
  id: "sh600519",
  name: "贵州茅台",
  dayDate: ENTRY_DAY,
  entry: 10,
  stop: 9,
  target: 12,
  hold: 8,
};

// ── 规矩 1：T+1 ──────────────────────────────────────────────────

test("🔴 买入日当天就算跌破止损，也不许当天成交（T+1）", () => {
  // 买入日自己最低 8.5（早破了止损 9），收盘 8.6。
  // 这天买的票当天卖不掉——任何按日 K 撮合的实现都不许在这一天返回成交。
  const bars = [
    bar(ENTRY_DAY, 10, 8.6, 10, 8.5),
    bar("2026-03-03", 8.6, 8.6),
    bar("2026-03-04", 8.6, 8.6),
  ];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.ok(fill, "第二天就该止损成交，不该交白卷");
  assert.notEqual(fill!.date, ENTRY_DAY, "成交日等于买入日 = 违反 T+1，这账不能要");
  assert.equal(fill!.date, "2026-03-03");
});

test("🔴 持有一天就到期（补涨那种），成交日只能是买入日的下一个交易日", () => {
  const bars = [bar(ENTRY_DAY, 10, 10), bar("2026-03-03", 10.5, 10.5), bar("2026-03-04", 11, 11)];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 1);
  assert.ok(fill);
  assert.equal(fill!.date, "2026-03-03");
  assert.equal(fill!.reason, "time");
});

// ── 规矩 2：不能用买入日收盘价卖 ────────────────────────────────

test("🔴 成交价绝不能取到买入日的收盘价", () => {
  // 把买入日收盘价做成一个「只要被误用就一定露馅」的数：9.37。
  // 后面几天的价全是 10.x，成交价出现 9.37 就说明拿买入日收盘价冒充了卖出价。
  const bars = [
    bar(ENTRY_DAY, 10.2, 9.37, 10.3, 9.3),
    bar("2026-03-03", 10.5, 10.5),
    bar("2026-03-04", 10.6, 10.6),
  ];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 1);
  assert.ok(fill);
  assert.notEqual(fill!.price, 9.37, "成交价取了买入日收盘价 = 用了当时不可能知道的价格");
  assert.equal(fill!.price, 10.5);
});

test("🔴 到期结算也不能把买入日当结算日（哪怕 hold 很小）", () => {
  const bars = [bar(ENTRY_DAY, 10, 9.1, 10.1, 9.0), bar("2026-03-03", 9.2, 9.2)];
  const verdict = settleOne({ ...base, hold: 1, bars });
  assert.equal(verdict.kind, "filled");
  assert.notEqual(verdict.kind === "filled" ? verdict.date : "", ENTRY_DAY);
});

// ── 规矩 3：不能看未来 ─────────────────────────────────────────

test("🔴 只喂到第 3 根，就不许凭空给出第 8 根的成交", () => {
  // 只有 3 个交易日，还没到期；返回一个未来的成交日 = 偷看。
  const bars = [bar(ENTRY_DAY, 10, 10), bar("2026-03-03", 10, 10), bar("2026-03-04", 10, 10)];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.equal(fill, null, "K 线没走到到期日就不该有成交");

  const verdict = settleOne({ ...base, bars });
  assert.deepEqual(verdict, { kind: "waiting", passed: 2 });
});

test("🔴 成交日永远落在喂进来的那几根 K 线之内", () => {
  const bars = Array.from({ length: 12 }, (_, i) => bar(`2026-03-${String(2 + i).padStart(2, "0")}`, 10, 10));
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.ok(fill);
  const dates = new Set(bars.map((b) => b.date));
  assert.ok(dates.has(fill!.date), `成交日 ${fill!.date} 不在 K 线里，凭空编了一个`);
});

// ── 规矩 4：这一分钟不知道下一分钟 ─────────────────────────────

test("🔴 这一分钟不知道下一分钟：没走完的当日 K 线不参与判定", () => {
  // 到期日当天盘中：账上那根 K 线的收盘价还是现价，最低价还在走。
  // 拿它结算 = 这分钟用了下一分钟（乃至收盘）的数据。
  const list = [
    bar(ENTRY_DAY, 10, 10),
    ...Array.from({ length: 8 }, (_, i) => bar(`2026-03-${String(3 + i).padStart(2, "0")}`, 10, 10)),
  ];
  const intraday = settleOne({ ...base, bars: list, today: "2026-03-10", todayClosed: false });
  assert.equal(intraday.kind, "waiting", "盘中不许结");
  const closed = settleOne({ ...base, bars: list, today: "2026-03-10", todayClosed: true });
  assert.equal(closed.kind, "filled", "收盘之后才允许结");
});

test("🔴 盘中那根的最低/最高价还没定型，不能拿它触发止损止盈", () => {
  // 到期日当天盘中最低摸到 8.8（破止损），收盘拉回 10.3 —— 事后看是虚惊一场。
  const list = [
    bar(ENTRY_DAY, 10, 10),
    ...Array.from({ length: 7 }, (_, i) => bar(`2026-03-${String(3 + i).padStart(2, "0")}`, 10, 10)),
    bar("2026-03-11", 10, 10.3, 10.5, 8.8),
  ];
  const intraday = settleOne({ ...base, bars: list, today: "2026-03-11", todayClosed: false });
  assert.equal(intraday.kind, "waiting");
});

test("盘中撮合只看传进来的这一个价，不是看当天最终价", () => {
  // 现价 9.5 在止损 9 上方 —— 就是不触发。当天后来跌到 8.5 是「下一分钟」的事，
  // 这一分钟不许拿它做决定。
  assert.equal(intradayFill(9.5, 9, 12), null);
  assert.deepEqual(intradayFill(8.8, 9, 12), { price: 8.8, reason: "stop" });
  assert.deepEqual(intradayFill(12.4, 9, 12), { price: 12, reason: "target" });
});

// ── 成交价必须「当时拿得到」 ────────────────────────────────────

test("止损成交价不能好于止损价（市价止损单不会成交在更好的位置）", () => {
  const bars = [bar(ENTRY_DAY, 10, 10), bar("2026-03-03", 10, 10, 10, 8.7)];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.ok(fill);
  assert.equal(fill!.reason, "stop");
  assert.ok(fill!.price <= 9, `止损成交价 ${fill!.price} 高于止损价 9，等于凭空捡钱`);
});

test("跳空低开时按开盘价成交，不许按止损价美化", () => {
  // 开盘直接 8.2（在止损 9 下方），这天拿不到 9 这个价。
  const bars = [bar(ENTRY_DAY, 10, 10), bar("2026-03-03", 8.2, 8.3, 8.4, 8.1)];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.ok(fill);
  assert.equal(fill!.price, 8.2);
});

test("止盈成交价不许高于目标价（限价卖单不会成交在更好的位置）", () => {
  const bars = [bar(ENTRY_DAY, 10, 10), bar("2026-03-03", 10, 12.8, 12.8, 10)];
  const fill = exitFill(bars, ENTRY_DAY, 10, 9, 12, 10, 8);
  assert.ok(fill);
  assert.equal(fill!.reason, "target");
  assert.equal(fill!.price, 12);
});
