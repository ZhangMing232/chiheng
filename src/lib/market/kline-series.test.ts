/**
 * 这个文件是干什么的：
 * 钉住 K 线数据层的口径——蜡烛四元组顺序、阴阳着色语义、MA 的前置 null。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCandles, maOf } from "@/lib/market/kline-series";

test("buildCandles：四元组是 [开,收,低,高]，阳=收>=开", () => {
  const bars = [
    { date: "2026-10-09", o: 10, c: 10.5, h: 10.8, l: 9.9, v: 100 },
    { date: "2026-10-12", o: 10.5, c: 10.2, h: 10.6, l: 10.0, v: 200 },
  ];
  const candles = buildCandles(bars);
  assert.deepEqual(candles[0]!.value, [10, 10.5, 9.9, 10.8]);
  assert.equal(candles[0]!.up, true, "收 > 开 = 阳");
  assert.equal(candles[1]!.up, false, "收 < 开 = 阴");
  assert.equal(candles[1]!.volume, 200);
});

test("buildCandles：残缺 K（收为 0）丢掉，不画假蜡烛", () => {
  const candles = buildCandles([{ date: "2026-10-12", o: 0, c: 0, h: 0, l: 0, v: 0 }]);
  assert.equal(candles.length, 0);
});

test("maOf：前 n-1 个是 null，之后是滑动均值", () => {
  const ma5 = maOf([1, 2, 3, 4, 5, 6], 5);
  assert.deepEqual(ma5.slice(0, 4), [null, null, null, null]);
  assert.equal(ma5[4], 3);
  assert.equal(ma5[5], 4);
});
