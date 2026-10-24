/**
 * backtest-day 的守门测试。钉的是 2026-10-24 修掉的那个 bug 的**不变式**，
 * 不是实现细节——谁再按信号日聚合、谁再让同一天多笔互相覆盖，这里红。
 *
 * 被测 bug（518e6c3 引入，活了 10 天）：bucket.get(t.exitDate) 之后
 * bucket.set(t.date, row)。实测后果：中期反转 2257 笔，daily 只剩 248 条、
 * 每条 n=1，/backtest 页曲线从 10-14 起就是错的；连亏天数和回撤两列同源。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay, dayRowsOf, benchRowsOf, type DayTrade } from "@/lib/market/backtest-day";

function trade(date: string, exitDate: string, ret: number, bench = 0): DayTrade {
  return { date, exitDate, ret, bench };
}

test("同一天平仓的多笔合并成一条，取等权平均", () => {
  const rows = dayRowsOf([
    trade("2026-09-01", "2026-09-10", 0.01),
    trade("2026-09-02", "2026-09-10", 0.03),
    trade("2026-09-03", "2026-09-10", -0.01),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 3);
  assert.ok(Math.abs(rows[0].ret - (0.01 + 0.03 - 0.01) / 3) < 1e-12);
});

test("聚合 key 是卖出日：信号日相同卖出日不同 → 必须是三条，key 各自不同", () => {
  // 这正是出 bug 的形状：同一天选出十只票，卖出日差几天。
  // 旧代码每个信号日只剩最后一笔（set 用 date 互相覆盖）。
  const rows = dayRowsOf([
    trade("2026-09-01", "2026-09-10", 0.01),
    trade("2026-09-01", "2026-09-11", 0.02),
    trade("2026-09-01", "2026-09-12", 0.03),
  ]);
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2026-09-10", "2026-09-11", "2026-09-12"],
  );
  assert.deepEqual(
    rows.map((r) => r.n),
    [1, 1, 1],
  );
});

test("反过来：信号日不同卖出日相同 → 必须合并（get 打不中就是这个反例）", () => {
  const rows = dayRowsOf([
    trade("2026-09-01", "2026-09-10", 0.01),
    trade("2026-09-05", "2026-09-10", 0.02),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
  assert.ok(Math.abs(rows[0].ret - 0.015) < 1e-12);
});

test("daily.n 合计等于笔数：一条都不许多、一条也不许少", () => {
  // 旧代码实测违反：2257 笔 → n 合计 248。
  const trades: DayTrade[] = [];
  for (let i = 0; i < 20; i += 1) {
    const signal = `2026-09-${String(1 + (i % 5)).padStart(2, "0")}`;
    const exit = `2026-09-${String(10 + (i % 7)).padStart(2, "0")}`;
    trades.push(trade(signal, exit, 0.001 * i - 0.005));
  }
  const rows = dayRowsOf(trades);
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  assert.equal(total, trades.length);
});

test("按日期升序输出：连亏天数数「连续」、回撤按天复利，乱序就是算错日子", () => {
  // 打乱输入顺序，输出必须还是升序
  const rows = dayRowsOf([
    trade("2026-09-05", "2026-09-12", 0.01),
    trade("2026-09-01", "2026-09-10", 0.02),
    trade("2026-09-03", "2026-09-11", 0.03),
  ]);
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2026-09-10", "2026-09-11", "2026-09-12"],
  );
  const days = byDay([
    trade("2026-09-05", "2026-09-12", -0.01),
    trade("2026-09-01", "2026-09-10", -0.02),
  ]);
  assert.equal(days.length, 2);
  assert.ok(days[0] < 0 && days[1] < 0);
});

test("byDay 与 dayRowsOf 同源同序：一个喂连亏/回撤，一个喂曲线，不许分叉", () => {
  const trades = [
    trade("2026-09-01", "2026-09-10", 0.01),
    trade("2026-09-01", "2026-09-10", 0.03),
    trade("2026-09-02", "2026-09-11", -0.02),
  ];
  assert.deepEqual(byDay(trades), dayRowsOf(trades).map((r) => r.ret));
});

test("benchRowsOf 聚的是 bench 不是 ret", () => {
  const rows = benchRowsOf([trade("2026-09-01", "2026-09-10", 0.05, 0.02), trade("2026-09-02", "2026-09-10", -0.01, 0.04)]);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].ret - 0.03) < 1e-12);
});

test("空输入返回空，不炸", () => {
  assert.deepEqual(byDay([]), []);
  assert.deepEqual(dayRowsOf([]), []);
  assert.deepEqual(benchRowsOf([]), []);
});
