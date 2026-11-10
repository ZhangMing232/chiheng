import assert from "node:assert/strict";
import { test } from "node:test";
import { LEG_HOLD_DAYS, legOf, holdDaysOf, exitTextOf, orderFieldsOf } from "./lib/signal-legs.ts";

test("两腿的走人日分开：短线 5 日，中长线 8 日", () => {
  assert.equal(LEG_HOLD_DAYS.short, 5, "短线沿用回测登记版 evt-themeLaggard hold=5");
  assert.equal(LEG_HOLD_DAYS.long, 8, "中长线沿用早盘推送纪律行口径");
  assert.notEqual(LEG_HOLD_DAYS.short, LEG_HOLD_DAYS.long, "两腿不能悄悄合成一个数");
});

test("旧候选文件没有 leg 时按策略名回退", () => {
  assert.equal(legOf({ strategy: "热点·题材补涨" }), "short");
  assert.equal(legOf({ strategy: "低估值" }), "long");
  assert.equal(legOf({ leg: "long", strategy: "热点·题材补涨" }), "long", "显式 leg 优先于策略名");
});

test("旧候选文件没有 holdDays 时按腿回退——不把缺字段当成 0 天", () => {
  assert.equal(holdDaysOf({ strategy: "热点·题材补涨", buyPrice: 10 }), 5);
  assert.equal(holdDaysOf({ strategy: "低估值", buyPrice: 10 }), 8);
  assert.equal(holdDaysOf({ leg: "short", holdDays: 0 }), 5, "0 不是有效天数");
  assert.equal(holdDaysOf({ leg: "short", holdDays: Number.NaN }), 5, "NaN 不是有效天数");
});

test("候选自带 holdDays 优先，改口径不用改推送代码", () => {
  assert.equal(holdDaysOf({ leg: "short", holdDays: 3 }), 3);
  assert.equal(exitTextOf({ leg: "long", holdDays: 20 }), "走 第20日");
});

test("每张单子四件事齐全：买多少、亏到哪走、赚到哪走、什么时候走", () => {
  const line = orderFieldsOf({ leg: "short", buyPrice: 40.9, stop: 37.63, target: 44.99 });
  assert.match(line, /买 40\.9/);
  assert.match(line, /止损 37\.63/);
  assert.match(line, /目标 44\.99/);
  assert.match(line, /走 第5日/);

  const long = orderFieldsOf({ leg: "long", buyPrice: 6.6, stop: 6.2, target: 7.39 });
  assert.match(long, /走 第8日/);
});

test("拿不到止损/目标写破折号，不许补 0 冒充价格", () => {
  const line = orderFieldsOf({ leg: "short", buyPrice: 10, stop: null, target: undefined });
  assert.match(line, /止损 —/);
  assert.match(line, /目标 —/);
  assert.doesNotMatch(line, /止损 0|目标 0/);
});
