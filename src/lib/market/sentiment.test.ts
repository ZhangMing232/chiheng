/**
 * 市场情绪温度计 <SentimentGauge/> 的纯计算测试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bandOf, computeSentiment } from "./sentiment.ts";

const base = { up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0 };

test("bandOf 五档边界", () => {
  assert.equal(bandOf(0), "冰点");
  assert.equal(bandOf(19.9), "冰点");
  assert.equal(bandOf(20), "偏冷");
  assert.equal(bandOf(39.9), "偏冷");
  assert.equal(bandOf(40), "温和");
  assert.equal(bandOf(59.9), "温和");
  assert.equal(bandOf(60), "过热");
  assert.equal(bandOf(79.9), "过热");
  assert.equal(bandOf(80), "沸点");
  assert.equal(bandOf(100), "沸点");
});

test("全面上涨的强市 → 高分·沸点区", () => {
  const r = computeSentiment(
    { ...base, up: 4500, down: 600, flat: 100, limitUp: 90, limitDown: 2 },
    [1.8, 2.2],
    120_000, // +120 亿
  );
  assert.ok(r.score != null && r.score > 80);
  assert.equal(r.band, "沸点");
  assert.match(r.line, /涨停 90/);
});

test("全面下跌的弱市 → 低分·冰点/偏冷", () => {
  const r = computeSentiment(
    { ...base, up: 400, down: 4600, flat: 100, limitUp: 1, limitDown: 60 },
    [-1.5, -2.0],
    -200_000,
  );
  assert.ok(r.score != null && r.score < 25);
  assert.ok(r.band === "冰点" || r.band === "偏冷");
});

test("没有涨跌停时按中性 50 计，不偏向任何一边", () => {
  const r = computeSentiment({ ...base, up: 2500, down: 2500 }, [0], 0);
  assert.equal(r.components.find((c) => c.key === "limit")!.score, 50);
  assert.equal(r.band, "温和");
});

test("数据缺失时降权重：指数和资金都没有，只用广度+涨跌停", () => {
  const r = computeSentiment({ ...base, up: 3000, down: 2000, limitUp: 40, limitDown: 10 }, [], null);
  assert.ok(Math.abs(r.weightUsed - 0.6) < 1e-9);
  assert.equal(r.components.find((c) => c.key === "index")!.score, null);
  // 广度 60、涨跌停 80，加权 (60*.4+80*.2)/.6 = 66.7
  assert.ok(r.score != null && r.score > 60 && r.score < 75);
});

test("全部数据缺失 → score 为 null，不编数", () => {
  const r = computeSentiment({ ...base }, [], null);
  assert.equal(r.score, null);
  assert.equal(r.band, null);
  assert.match(r.line, /不可用/);
});

test("事实行带真实数字（出处要求）", () => {
  const r = computeSentiment(
    { ...base, up: 3000, down: 2000, flat: 300, limitUp: 45, limitDown: 5 },
    [0.85, 1.1],
    88_000,
  );
  assert.match(r.components.find((c) => c.key === "breadth")!.fact, /上涨 3000/);
  assert.match(r.components.find((c) => c.key === "flow")!.fact, /8\.8 亿/);
  assert.match(r.components.find((c) => c.key === "index")!.fact, /\+0\.98%/);
});
