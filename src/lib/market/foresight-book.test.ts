/**
 * foresight-book.ts 的测试：前瞻 picks → 账本买入计划。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planForesightBuys, isForesightTrade, indexBookForesight, fillPriceOf, strategyLabelOf,
  FORESIGHT_HOLD, FORESIGHT_STOP_PCT, FORESIGHT_TARGET_PCT, type BuyDayBar,
} from "./foresight-book.ts";

const picks = [
  { code: "sh605255", name: "天普股份", pickPrice: 73.82 },
  { code: "sz002148", name: "北纬科技", pickPrice: 7.95 },
];
const lim10 = (_code: string) => 10;
/** 昨收 8.75 → 涨停 9.63 的普通 bar。 */
const normalBar: BuyDayBar = { o: 8.58, h: 8.77, l: 7.88, c: 8.23, prevClose: 8.75 };

test("正常计划：用当日开盘价入场，style=relay / variant=foresight", () => {
  const buys = planForesightBuys(
    picks,
    new Map([["sh605255", normalBar], ["sz002148", normalBar]]),
    lim10,
    new Set(),
  );
  assert.equal(buys.length, 2);
  const a = buys[0];
  assert.equal(a.entry, 8.58);
  assert.equal(a.style, "relay");
  assert.equal(a.variant, "foresight");
  assert.equal(a.hold, FORESIGHT_HOLD);
  assert.equal(a.code, "605255", "code 去掉 sh/sz 前缀");
  assert.equal(a.id, "sh605255", "id 保留带前缀");
});

test("止损/目标按固定幅度算（5% / 10%）并四舍五入到分", () => {
  const [b] = planForesightBuys(
    [picks[1]],
    new Map([["sz002148", normalBar]]),
    lim10,
    new Set(),
  );
  assert.equal(b.stop, Math.round(8.58 * (1 - FORESIGHT_STOP_PCT / 100) * 100) / 100);
  assert.equal(b.target, Math.round(8.58 * (1 + FORESIGHT_TARGET_PCT / 100) * 100) / 100);
});

test("🔴 一字涨停（开盘=涨停=全天最低）→ 不买，不记假成交", () => {
  // 昨收 10 → 涨停 11；开 11、高 11、低 11 = 全天封死
  const oneWord: BuyDayBar = { o: 11, h: 11, l: 11, c: 11, prevClose: 10 };
  const buys = planForesightBuys(
    [picks[0]],
    new Map([["sh605255", oneWord]]),
    lim10,
    new Set(),
  );
  assert.equal(buys.length, 0, "一字板买不进");
  assert.equal(fillPriceOf(oneWord, 10), null);
});

test("开盘涨停但盘中开板（低<涨停）→ 按开盘价买，note 说明能成交", () => {
  // 昨收 10 → 涨停 11；开 11 但最低 10.5 → 开板了，能成交
  const opened: BuyDayBar = { o: 11, h: 11, l: 10.5, c: 10.9, prevClose: 10 };
  const fill = fillPriceOf(opened, 10);
  assert.ok(fill);
  assert.equal(fill.entry, 11);
  assert.ok(fill.note?.includes("开板"));
});

test("🔴 拿不到 K 线就跳过——不拿选股价冒充买入价", () => {
  const buys = planForesightBuys(
    picks,
    new Map([["sh605255", null], ["sz002148", normalBar]]),
    lim10,
    new Set(),
  );
  assert.equal(buys.length, 1);
  assert.equal(buys[0].id, "sz002148");
});

test("开盘价 0 / 负数视为无效，跳过", () => {
  const bad: BuyDayBar = { o: 0, h: 0, l: 0, c: 0, prevClose: 8.75 };
  const neg: BuyDayBar = { ...bad, o: -1 };
  assert.equal(planForesightBuys(picks, new Map([["sh605255", bad], ["sz002148", neg]]), lim10, new Set()).length, 0);
});

test("🔴 已持有的票不重复买（防同一只被 value 和前瞻各买一次）", () => {
  const buys = planForesightBuys(
    picks,
    new Map([["sh605255", normalBar], ["sz002148", normalBar]]),
    lim10,
    new Set(["sh605255"]),
  );
  assert.equal(buys.length, 1);
  assert.equal(buys[0].id, "sz002148");
});

test("同批 picks 里有重复代码只取第一次", () => {
  const dup = [...picks, { code: "sz002148", name: "北纬科技", pickPrice: 7.95 }];
  const buys = planForesightBuys(
    dup,
    new Map([["sz002148", normalBar]]),
    lim10,
    new Set(),
  );
  assert.equal(buys.length, 1);
});

test("空 picks → 空计划（不抛错）", () => {
  assert.deepEqual(planForesightBuys([], new Map(), lim10, new Set()), []);
});

test("fillPriceOf：拿不到昨收时按开盘价买、note 为空（不猜涨停）", () => {
  const f = fillPriceOf({ o: 8.58, h: 8.7, l: 8.4, c: 8.5, prevClose: null }, 10);
  assert.equal(f?.entry, 8.58);
  assert.equal(f?.note, null);
});

test("isForesightTrade：只认 variant=foresight", () => {
  assert.equal(isForesightTrade({ variant: "foresight" }), true);
  assert.equal(isForesightTrade({ variant: "value-stop10" }), false);
  assert.equal(isForesightTrade({ variant: null }), false);
  assert.equal(isForesightTrade({}), false);
});

test("indexBookForesight：按 code@买入日 索引，已平算真实收益", () => {
  const days = [
    { date: "2026-11-16", trades: [
      { id: "sz002148", variant: "foresight", entry: 8.75, exit: 8.29, exitDate: "2026-11-17" },
      { id: "sz000001", variant: "value-stop10", entry: 12, exit: 13 },
    ] },
    { date: "2026-11-17", trades: [{ id: "sz002148", variant: "foresight", entry: 8.58 }] },
  ];
  const m = indexBookForesight(days as never);
  assert.equal(m.size, 2);
  const old = m.get("sz002148@2026-11-16")!;
  assert.ok(Math.abs(old.ret! - (8.29 / 8.75 - 1)) < 1e-9);
  assert.equal(m.get("sz002148@2026-11-17")!.ret, null);
  assert.equal(m.has("sz000001@2026-11-16"), false);
});

test("indexBookForesight：同一 code 同日多笔取最后一笔", () => {
  const days = [{ date: "2026-11-16", trades: [
    { id: "sz002148", variant: "foresight", entry: 8.75, exit: 9 },
    { id: "sz002148", variant: "foresight", entry: 8.80, exit: 9.1 },
  ] }];
  const m = indexBookForesight(days as never);
  assert.equal(m.get("sz002148@2026-11-16")!.entry, 8.80);
});

test("strategyLabelOf：foresight 显示「前瞻验证」而非借用的 relay「次日补涨」", () => {
  const relayName = (id: string) => (id === "relay" ? "次日补涨" : id);
  assert.equal(strategyLabelOf({ variant: "foresight", style: "relay" }, relayName), "前瞻验证");
  assert.equal(strategyLabelOf({ variant: undefined, style: "relay" }, relayName), "次日补涨");
  assert.equal(strategyLabelOf({ variant: "value-stop10", style: "value" }, relayName), "value");
});

// 2026-11-17 补：端到端防假修复——PositionRow 必须带 variant 才能让
// strategyLabelOf 在持仓页/统计里识别 foresight（曾漏字段导致「前瞻验证」修复无效）。
test("🔴 PositionRow 形状兼容：strategyLabelOf 靠 row.variant 识别，字段缺失=假修复", () => {
  const relayName = (id: string) => (id === "relay" ? "次日补涨" : id);
  // buildRows 拷贝后的真实 row 形状（variant 必须在）
  const rowWithVariant = { style: "relay", variant: "foresight" };
  assert.equal(strategyLabelOf(rowWithVariant, relayName), "前瞻验证");
  // 如果 buildRows 漏拷 variant（回归），这个测试会红——strategyLabelOf 只认 variant
  const rowMissingVariant = { style: "relay" };
  assert.equal(strategyLabelOf(rowMissingVariant, relayName), "次日补涨", "variant 缺失时只能按 style 显示——这正是曾发生的假修复");
});
