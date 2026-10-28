/**
 * 快捷键策略循环的纯函数测试。
 *
 * 为什么值得单测：这个函数只在真机按键时跑，而沙箱里跑不了浏览器
 * （Chrome 起不来）。越界、不环回、空表崩溃这三类错，肉眼在页面上
 * 要连按好几次才能碰上一次——写成纯函数就能一次全测。
 *
 * 2026-10-28 起 cycleStyle 用**字面量数组**测，不再拿 ACTIVE_STYLES 当夹具：
 * 那天中期反转下线，ACTIVE_STYLES 缩成单元素，`ORDER[1]` 变成 undefined，
 * 三条用例跟着红——而函数本身一点没坏。配置变了不该让契约测试陪着崩。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cycleStyle } from "@/lib/market/strategies";
import { ACTIVE_STYLES } from "@/lib/market/strategies";

const ABC = ["a", "b", "c"] as const;

test("cycleStyle：往右到头环回，不越界", () => {
  assert.equal(cycleStyle(ABC, "a", 1), "b");
  assert.equal(cycleStyle(ABC, "c", 1), "a", "最后一套再往右要回到第一套");
});

test("cycleStyle：往左到头环回", () => {
  assert.equal(cycleStyle(ABC, "a", -1), "c", "第一套再往左要去最后一套");
  assert.equal(cycleStyle(ABC, "b", -1), "a");
});

test("cycleStyle：当前项不在表里时给第一项（按键总要有个去处）", () => {
  assert.equal(cycleStyle(ABC, "trend", 1), "a", "不在表里的策略要被兜到第一项");
  assert.equal(cycleStyle(ABC, "不存在的策略", -1), "a");
});

test("cycleStyle：空表返回 null（调用方负责不崩）", () => {
  assert.equal(cycleStyle([], "breakout", 1), null);
});

test("cycleStyle：单元素表按哪个方向都是自己", () => {
  assert.equal(cycleStyle(["rebound"], "rebound", 1), "rebound");
  assert.equal(cycleStyle(["rebound"], "rebound", -1), "rebound");
});

test("🔴 ACTIVE_STYLES 不能为空（空表会让页面上的 ← → 无处可去）", () => {
  assert.ok(ACTIVE_STYLES.length > 0);
});

test("🔴 中期反转没被悄悄加回 ACTIVE_STYLES", () => {
  // 2026-10-28 下线，依据是双证据同向：近全池回测 -0.28pp（t=-1.92）、
  // 2026-09-29 后 136 笔 -4.28pp（t=-11.27，胜率 4%）、真账本 17 笔 -13.02%。
  // 重开的话请改掉这条用例，并在提交信息里写清新证据——不要因为「跌多了该反弹」就加回来。
  assert.equal(
    (ACTIVE_STYLES as string[]).includes("rebound"),
    false,
    "中期反转已下线，重开需要新证据（见 data/backtest/2026-10-28/REPORT.md）",
  );
});
