/**
 * /today 矩阵分组的守门测试（2026-11-14 第 12 轮）。
 *
 * 背景：实测 19 行矩阵里 8 行是短线腿的观察行（占 38% 矩阵高度），
 * 而短线腿所属策略已淘汰、这些票永远不会建仓。用户打开「今天买什么」
 * 却先看到一堆买不了的票——核心信息被稀释。
 *
 * 保护的核心纪律：**分组不丢行**。折叠是展示方式，不是删除。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMatrixRows } from "@/lib/market/matrix-split";

const row = (name: string, observeOnly?: boolean) => ({ name, observeOnly });

test("🔴 观察行与可操作行分开，且两组加起来等于原行数（不丢行）", () => {
  const rows = [
    row("天普股份"),
    row("北纬科技"),
    row("新易盛", true),
    row("源杰科技", true),
    row("华夏银行"),
  ];
  const { actionable, observing } = splitMatrixRows(rows);
  assert.equal(actionable.length, 3);
  assert.equal(observing.length, 2);
  assert.equal(actionable.length + observing.length, rows.length, "分组不能丢行");
  assert.deepEqual(observing.map((r) => r.name), ["新易盛", "源杰科技"]);
});

test("全是观察行时，可操作组为空（页面显示「今天没有可成交的候选」）", () => {
  const { actionable, observing } = splitMatrixRows([row("A", true), row("B", true)]);
  assert.equal(actionable.length, 0);
  assert.equal(observing.length, 2);
});

test("没有观察行时，观察组为空（页面不渲染折叠块）", () => {
  const { actionable, observing } = splitMatrixRows([row("A"), row("B")]);
  assert.equal(actionable.length, 2);
  assert.equal(observing.length, 0);
});

test("保持原顺序，不重排", () => {
  const rows = [row("A"), row("B", true), row("C"), row("D", true)];
  const { actionable, observing } = splitMatrixRows(rows);
  assert.deepEqual(actionable.map((r) => r.name), ["A", "C"]);
  assert.deepEqual(observing.map((r) => r.name), ["B", "D"]);
});

test("observeOnly=undefined 算可操作（不是 falsy 就当观察）", () => {
  const { actionable, observing } = splitMatrixRows<{ name: string; observeOnly?: boolean }>([{ name: "X" }]);
  assert.equal(actionable.length, 1);
  assert.equal(observing.length, 0);
});

test("空数组不炸", () => {
  const { actionable, observing } = splitMatrixRows([]);
  assert.equal(actionable.length, 0);
  assert.equal(observing.length, 0);
});
