/**
 * foresight-book.ts 的测试：前瞻 picks → 账本买入计划。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planForesightBuys, isForesightTrade, FORESIGHT_HOLD, FORESIGHT_STOP_PCT, FORESIGHT_TARGET_PCT } from "./foresight-book.ts";

const picks = [
  { code: "sh605255", name: "天普股份", pickPrice: 73.82 },
  { code: "sz002148", name: "北纬科技", pickPrice: 7.95 },
];

test("正常计划：用当日开盘价入场，style=relay / variant=foresight", () => {
  const buys = planForesightBuys(picks, new Map([["sh605255", 74], ["sz002148", 8.75]]), new Set());
  assert.equal(buys.length, 2);
  const a = buys[0];
  assert.equal(a.entry, 74);
  assert.equal(a.style, "relay");
  assert.equal(a.variant, "foresight");
  assert.equal(a.hold, FORESIGHT_HOLD);
  assert.equal(a.code, "605255", "code 去掉 sh/sz 前缀");
  assert.equal(a.id, "sh605255", "id 保留带前缀");
});

test("止损/目标按固定幅度算（5% / 10%）并四舍五入到分", () => {
  const [b] = planForesightBuys([picks[1]], new Map([["sz002148", 8.75]]), new Set());
  assert.equal(b.stop, Math.round(8.75 * (1 - FORESIGHT_STOP_PCT / 100) * 100) / 100);
  assert.equal(b.target, Math.round(8.75 * (1 + FORESIGHT_TARGET_PCT / 100) * 100) / 100);
});

test("🔴 拿不到开盘价就跳过——不拿选股价冒充买入价", () => {
  const buys = planForesightBuys(picks, new Map([["sh605255", null], ["sz002148", 8.75]]), new Set());
  assert.equal(buys.length, 1);
  assert.equal(buys[0].id, "sz002148");
});

test("开盘价 0 / 负数视为无效（停牌或缺数据），跳过", () => {
  assert.equal(planForesightBuys(picks, new Map([["sh605255", 0], ["sz002148", -1]]), new Set()).length, 0);
});

test("🔴 已持有的票不重复买（防同一只被 value 和前瞻各买一次）", () => {
  const buys = planForesightBuys(picks, new Map([["sh605255", 74], ["sz002148", 8.75]]), new Set(["sh605255"]));
  assert.equal(buys.length, 1);
  assert.equal(buys[0].id, "sz002148");
});

test("同批 picks 里有重复代码只取第一次", () => {
  const dup = [...picks, { code: "sz002148", name: "北纬科技", pickPrice: 7.95 }];
  const buys = planForesightBuys(dup, new Map([["sz002148", 8.75]]), new Set());
  assert.equal(buys.length, 1);
});

test("空 picks → 空计划（不抛错）", () => {
  assert.deepEqual(planForesightBuys([], new Map(), new Set()), []);
});

test("isForesightTrade：只认 variant=foresight，冠军/challenger 不算", () => {
  assert.equal(isForesightTrade({ variant: "foresight" }), true);
  assert.equal(isForesightTrade({ variant: "value-stop10" }), false);
  assert.equal(isForesightTrade({ variant: null }), false);
  assert.equal(isForesightTrade({}), false);
});
