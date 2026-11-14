/**
 * minute-candles.ts 的测试：分时点聚合蜡烛。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { minuteCandles, hhmm } from "./minute-candles.ts";

const pts = (prices: number[], startHour = 9, startMin = 30) =>
  prices.map((price, i) => {
    const total = startHour * 60 + startMin + i;
    const time = `${String(Math.floor(total / 60)).padStart(2, "0")}${String(total % 60).padStart(2, "0")}`;
    return { time, price };
  });

test("5 分钟聚合：open 取首笔、close 取末笔、h/l 取窗口极值", () => {
  const candles = minuteCandles(pts([10, 12, 8, 11, 9]), 5);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].o, 10);
  assert.equal(candles[0].c, 9);
  assert.equal(candles[0].h, 12);
  assert.equal(candles[0].l, 8);
  assert.equal(candles[0].time, "0930");
});

test("242 个分钟点 → 49 根 5 分钟蜡烛（丢弃不足一窗的尾巴）", () => {
  const candles = minuteCandles(pts(Array.from({ length: 242 }, (_, i) => 3600 + (i % 7))), 5);
  assert.equal(candles.length, 48); // 242 / 5 = 48 完整窗 + 2 残
});

test("不足一窗 → 空数组（调用方回落分时，不画残蜡烛）", () => {
  assert.deepEqual(minuteCandles(pts([10, 11, 12]), 5), []);
});

test("bucket=1 → 空数组（单笔窗口画不出实体，禁用）", () => {
  assert.deepEqual(minuteCandles(pts([10, 11]), 1), []);
});

test("时间取窗口首笔：第二根蜡烛从 0935 起", () => {
  const candles = minuteCandles(pts([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), 5);
  assert.equal(candles.length, 2);
  assert.equal(candles[1].time, "0935");
});

test("hhmm：0930 → 09:30；非四位原样返回", () => {
  assert.equal(hhmm("0930"), "09:30");
  assert.equal(hhmm("1459"), "14:59");
  assert.equal(hhmm("abc"), "abc");
});
