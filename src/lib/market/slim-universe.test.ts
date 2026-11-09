/**
 * marketBreadth / 涨跌分桶的守门测试。
 * 分桶是效果图直方图的口径（涨跌停单列、中间九档），页面数字全靠它，
 * 口径漂了图就是错的——这里把分桶边界钉死。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { marketBreadth } from "@/lib/market/slim-universe";
import type { Quote } from "@/lib/market/types";

function q(chg: number | null, extra: Partial<Quote> = {}): Quote {
  return { id: "sh600000", code: "600000", name: "测", board: "sh", price: 10, chg, ...extra } as Quote;
}

test("分桶边界：涨跌停单列，中间九档各归各", () => {
  const quotes = [
    q(9.98, { price: 10 }), // 涨停（主板 10% 板）
    q(-9.98, { price: 10 }), // 跌停
    q(8.2), // >+7
    q(6.1), // 5~7
    q(3.4), // 3~5
    q(1.2), // 0~3
    q(0.0005), // 平盘（|chg|≤0.001 视为平）
    q(-1.2), // 0~-3
    q(-3.4), // -3~-5
    q(-6.1), // -5~-7
    q(-8.2), // <-7
  ];
  const b = marketBreadth(quotes).buckets!;
  assert.equal(b.upLimit, 1);
  assert.equal(b.downLimit, 1);
  assert.equal(b.gt7, 1);
  assert.equal(b.p5_7, 1);
  assert.equal(b.p3_5, 1);
  assert.equal(b.p0_3, 1);
  assert.equal(b.flat, 1);
  assert.equal(b.n0_3, 1);
  assert.equal(b.n3_5, 1);
  assert.equal(b.n5_7, 1);
  assert.equal(b.lt7, 1);
});

test("分桶合计 = 有效行情数（chg 为 null 不进任何桶）", () => {
  const quotes = [q(1), q(-1), q(null)];
  const b = marketBreadth(quotes).buckets!;
  const sum = Object.values(b).reduce((a, v) => a + v, 0);
  assert.equal(sum, 2);
});

test("涨跌家数和分桶的一致性：涨桶+平+跌桶 = 总数", () => {
  const quotes = [q(9.98, { price: 10 }), q(2), q(-2), q(-8), q(0)];
  const r = marketBreadth(quotes);
  const b = r.buckets!;
  assert.equal(r.up, 2); // 涨停 + 2
  assert.equal(r.down, 2);
  assert.equal(b.upLimit + b.gt7 + b.p5_7 + b.p3_5 + b.p0_3, r.up);
  assert.equal(b.downLimit + b.lt7 + b.n5_7 + b.n3_5 + b.n0_3, r.down);
});
