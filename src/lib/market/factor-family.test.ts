/** factor-family 的测试：族 + 方向都相同才点名。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { familyClashes, familyOf } from "./factor-family.ts";

test("familyOf：没标家族的自成一族", () => {
  assert.equal(familyOf({ id: "ai-slug", name: "x", direction: 1 }), "ai-slug");
  assert.equal(familyOf({ id: "std20", name: "x", direction: -1, family: "低波" }), "低波");
});

test("同族同方向 ≥2 个才点名，单个不算", () => {
  const clashes = familyClashes([
    { id: "std20", name: "20日波动率", direction: -1, family: "低波" },
    { id: "std60", name: "60日波动率", direction: -1, family: "低波" },
    { id: "amp20", name: "20日振幅", direction: -1, family: "低波" },
    { id: "rsi14", name: "RSI14", direction: -1, family: "RSI" }, // 单族，不点
  ]);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].family, "低波");
  assert.equal(clashes[0].members.length, 3);
});

test("同族不同方向不算 clash——反转和动量同源但一个赚一个亏", () => {
  const clashes = familyClashes([
    { id: "d20", name: "20日涨幅", direction: 1, family: "涨幅" },
    { id: "d60", name: "60日涨幅", direction: -1, family: "涨幅" },
  ]);
  assert.equal(clashes.length, 0);
});

test("AI 队列因子没标家族：各自成族，永不误报", () => {
  const clashes = familyClashes([
    { id: "ai-alpha", name: "a", direction: 1 },
    { id: "ai-beta", name: "b", direction: 1 },
  ]);
  assert.equal(clashes.length, 0);
});

test("输出按族名排序、成员按 id 排序——页面渲染和测试都稳定", () => {
  const clashes = familyClashes([
    { id: "c", name: "股价", direction: -1, family: "规模" },
    { id: "amountWan", name: "成交额", direction: -1, family: "规模" },
    { id: "std60", name: "60日波动率", direction: -1, family: "低波" },
    { id: "std20", name: "20日波动率", direction: -1, family: "低波" },
  ]);
  assert.deepEqual(clashes.map((c) => c.family), ["低波", "规模"]);
  assert.deepEqual(clashes[0].members.map((m) => m.id), ["std20", "std60"]);
});
