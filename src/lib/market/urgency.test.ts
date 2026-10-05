/**
 * 这个文件是干什么的：
 * 守住持仓列表的排序：能动手的排最前，紧急但动不了的（跌停、T+1）次之，
 * 剩下的按收益率从低到高。
 *
 * 你需要知道的：
 * 盘中第 ② 步是最高频动作——每 60 秒扫一眼「谁到止损/目标价了」。
 * 排序错了不会崩，但会让人在一屏 60 行里自己找那几只到价的，那几秒最贵。
 * 另外「拿不到现价」时收益率先当最差，亏得排在前面总比藏起来好。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsAction, sortByUrgency, urgencyOf, URGENCY, type PositionRow } from "@/lib/market/positions";

function row(patch: Partial<PositionRow> & { id: string }): PositionRow {
  return {
    code: patch.id, name: patch.id, entry: 10, exit: null, exitDate: null,
    day: "2026-09-30", signalTime: "09:41", live: null, state: "持有",
    ret: 0, pnl: 0, indexRet: null, style: undefined, stop: undefined, target: undefined,
    ...patch,
  } as PositionRow;
}

test("紧迫度分级：能动手的排最前", () => {
  assert.equal(urgencyOf({ state: "止损", exit: null }), URGENCY.stop);
  assert.equal(urgencyOf({ state: "卖出", exit: null }), URGENCY.target);
  assert.equal(urgencyOf({ state: "跌停", exit: null }), URGENCY.limitDown);
  assert.equal(urgencyOf({ state: "T+1", exit: null }), URGENCY.t1);
  assert.equal(urgencyOf({ state: "持有", exit: null }), URGENCY.hold);
  // 已卖的永远排最后，哪怕它当时是止损出的
  assert.equal(urgencyOf({ state: "止损", exit: 9 }), URGENCY.closed);
});

test("认不出来的状态按正常持有处理，不猜", () => {
  // 状态字符串是页面上来的，理论上会有没见过的值。这种情况不能瞎猜成紧急，
  // 也不能瞎猜成已卖——按持有处理，排序位置在中间，不会误导人。
  assert.equal(urgencyOf({ state: "看不懂的状态", exit: null }), URGENCY.hold);
});

test("需要处理的包含跌停——卖不出也要让人看见", () => {
  assert.equal(needsAction(row({ id: "a", state: "止损" })), true);
  assert.equal(needsAction(row({ id: "b", state: "卖出" })), true);
  assert.equal(needsAction(row({ id: "c", state: "跌停" })), true);
  assert.equal(needsAction(row({ id: "d", state: "T+1" })), false);
  assert.equal(needsAction(row({ id: "e", state: "持有" })), false);
  assert.equal(needsAction(row({ id: "f", exit: 11, state: "止损" })), false);
});

test("排序：止损 → 卖出 → 跌停 → T+1 → 持有 → 已卖", () => {
  const sorted = sortByUrgency([
    row({ id: "持有", state: "持有", ret: 0.01 }),
    row({ id: "已卖", state: "止损", exit: 9 }),
    row({ id: "T1", state: "T+1" }),
    row({ id: "跌停", state: "跌停" }),
    row({ id: "卖出", state: "卖出" }),
    row({ id: "止损", state: "止损" }),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ["止损", "卖出", "跌停", "T1", "持有", "已卖"]);
});

test("同一档内按收益率从低到高——先看亏得最多的", () => {
  const sorted = sortByUrgency([
    row({ id: "赚10", state: "持有", ret: 0.10 }),
    row({ id: "亏8", state: "持有", ret: -0.08 }),
    row({ id: "赚2", state: "持有", ret: 0.02 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ["亏8", "赚2", "赚10"]);
});

test("拿不到现价（ret 为 null）时排在有数的后面，不假装赚得多", () => {
  // null 不是 0，是「不知道」。当 +∞ 处理 = 排最后 = 不假装它是最好的。
  const sorted = sortByUrgency([
    row({ id: "没行情", state: "持有", ret: null }),
    row({ id: "小赚", state: "持有", ret: 0.001 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ["小赚", "没行情"]);
});

test("排序稳定：同档同收益率时保持原顺序", () => {
  const sorted = sortByUrgency([
    row({ id: "a", state: "持有", ret: 0.01 }),
    row({ id: "b", state: "持有", ret: 0.01 }),
    row({ id: "c", state: "持有", ret: 0.01 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.id), ["a", "b", "c"]);
});

test("不改动传入的数组", () => {
  const input = [row({ id: "持有", state: "持有" }), row({ id: "止损", state: "止损" })];
  const before = input.map((r) => r.id);
  sortByUrgency(input);
  assert.deepEqual(input.map((r) => r.id), before);
});
