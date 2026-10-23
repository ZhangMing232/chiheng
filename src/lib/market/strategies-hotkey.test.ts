/**
 * 快捷键策略循环的纯函数测试。
 *
 * 为什么值得单测：这个函数只在真机按键时跑，而沙箱里跑不了浏览器
 * （Chrome 起不来）。越界、不环回、空表崩溃这三类错，肉眼在页面上
 * 要连按好几次才能碰上一次——写成纯函数就能一次全测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cycleStyle } from "@/lib/market/strategies";
import { ACTIVE_STYLES } from "@/lib/market/strategies";

const ORDER = ACTIVE_STYLES as readonly string[];

test("cycleStyle：往右到头环回，不越界", () => {
  assert.equal(cycleStyle(ORDER, ORDER[0]!, 1), ORDER[1]);
  assert.equal(cycleStyle(ORDER, ORDER[ORDER.length - 1]!, 1), ORDER[0], "最后一套再往右要回到第一套");
});

test("cycleStyle：往左到头环回", () => {
  assert.equal(cycleStyle(ORDER, ORDER[0]!, -1), ORDER[ORDER.length - 1], "第一套再往左要去最后一套");
  assert.equal(cycleStyle(ORDER, ORDER[1]!, -1), ORDER[0]);
});

test("cycleStyle：当前项不在表里时给第一项（按键总要有个去处）", () => {
  assert.equal(cycleStyle(ORDER, "trend", 1), ORDER[0], "trend 已不自动建仓，不在表里");
  assert.equal(cycleStyle(ORDER, "不存在的策略", -1), ORDER[0]);
});

test("cycleStyle：空表返回 null（调用方负责不崩）", () => {
  assert.equal(cycleStyle([], "breakout", 1), null);
});

test("cycleStyle：单元素表按哪个方向都是自己", () => {
  assert.equal(cycleStyle(["rebound"], "rebound", 1), "rebound");
  assert.equal(cycleStyle(["rebound"], "rebound", -1), "rebound");
});
