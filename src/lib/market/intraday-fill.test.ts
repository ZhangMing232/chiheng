/**
 * 这个文件是干什么的：
 * 钉住 intraday-fill.ts 的行为——它决定账上每一笔卖出记什么价，而真钱硬闸
 * `hardGate` 就是拿这些数算「最近 20 笔均值」的。记账口径松一格，闸门就晚一格触发。
 *
 * 为什么要单独一个文件：
 * 修复之前，`scripts/record-journal.ts` 判定用现价、记账用计划价，而
 * `journal-book.test.ts:130` 恰好有一条测试叫「跳空低开穿过止损，按开盘价成交」
 * ——**尺子（exitFill）造对了也测了，用尺子的那只手没跟上**。而且那份代码在
 * `scripts/` 下，既不在 tsconfig 的 include 里（连类型检查都不做），文件名也不匹配
 * 任何 test glob（零覆盖）。所以这道口子从 2026-10-06 一直开到 10-08 盘中。
 *
 * 所以这里的第一条测试故意和 `journal-book.test.ts:130` 写成同构的用例，
 * 两条并排看就能对照出「日线路径」和「盘中路径」现在说的是同一件事。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { intradayFill } from "@/lib/market/intraday-fill";

test("跳空低开穿过止损：记开盘那一瞬的现价，不是止损价（与 exitFill 的日线测试同构）", () => {
  // 和 journal-book.test.ts:130 那条「跳空低开穿过止损，按开盘价成交」用同一组数：
  // 日线路径有开盘价，所以 exitFill 记 5；盘中只有现价 8.7，就记 8.7。
  // 两者都往不利的方向修正，这正是修复的目的。
  const result = intradayFill(8.7, 9.7, 11.5);
  assert.deepEqual(result, { price: 8.7, reason: "stop" });
  assert.notEqual(result?.price, 9.7, "拿止损价冒充成交价就是原来的 bug");
});

test("现价恰好等于止损价：按止损价成交，不修正", () => {
  // 没有跳空，成交价就是止损价本身。这一条钉住「修正只在现价更低时才发生」。
  assert.deepEqual(intradayFill(9.7, 9.7, 11.5), { price: 9.7, reason: "stop" });
});

test("现价跌破止损价多少就记多少，不会被止损价托住", () => {
  // 连续几个价位都往下，确保 min() 真的取了现价而不是止损价。
  for (const price of [9.69, 9.0, 5, 0.01]) {
    assert.equal(intradayFill(price, 9.7, 11.5)?.price, price, `现价 ${price} 应按现价成交`);
  }
});

test("止盈：现价高于卖出价仍按卖出价成交（限价单不会成交在更好的位置）", () => {
  // 止损要往下修正、止盈不修正——这两个方向不一样，不能写成同一个公式。
  assert.deepEqual(intradayFill(12, 9.7, 11.5), { price: 11.5, reason: "target" });
  assert.deepEqual(intradayFill(30, 9.7, 11.5), { price: 11.5, reason: "target" });
  assert.deepEqual(intradayFill(11.5, 9.7, 11.5), { price: 11.5, reason: "target" });
});

test("中间价位不触发，返回 null", () => {
  assert.equal(intradayFill(10, 9.7, 11.5), null);
  assert.equal(intradayFill(10.5, 9.7, 11.5), null);
});

test("非法输入一律当作没触发，不记假成交", () => {
  // 账本里出现过被手改坏的数据。说不清买卖价的输入宁可漏记，不要记假账。
  assert.equal(intradayFill(0, 9.7, 11.5), null, "现价为 0");
  assert.equal(intradayFill(10, 0, 11.5), null, "止损价为 0");
  assert.equal(intradayFill(10, -1, 11.5), null, "止损价为负");
  assert.equal(intradayFill(10, 11, 9), null, "止损比止盈还高，说不清买卖价");
  assert.equal(intradayFill(10, 9.7, 9.7), null, "止损等于止盈，同样说不清");
});

test("跌停封死不由这里判——那是调用方的活", () => {
  // 现价 = 止损价这一条是「恰好触及」，不是「封死」。封死意味着当天最低价一直压在
  // 跌停价上、根本卖不掉，得靠 high/low 才能判断，而 intradayFill 拿不到这两个数。
  // 所以 record-journal 在调用本函数之前先用 limitTag 挡掉跌停——那是它的工作，
  // 这里不重复判，也不该在这里判（判了也判不准）。
  assert.deepEqual(intradayFill(9.7, 9.7, 11.5), { price: 9.7, reason: "stop" });
});