/**
 * flow.ts 的纯函数测试：北向降级判定。
 * （fetchRetry / loadFlow 会联网，属集成路径，不在这里测。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNorthDegraded } from "./flow.ts";

test("isNorthDegraded：两条腿都拉不到 = 降级", () => {
  assert.equal(isNorthDegraded([]), true);
});

test("isNorthDegraded：只有沪股通一条也有数据，不算降级", () => {
  assert.equal(isNorthDegraded([{ name: "沪股通", date: "2026-11-14", amount: 100, leader: "" }]), false);
});

test("isNorthDegraded：两条腿齐 = 不降级", () => {
  assert.equal(isNorthDegraded([
    { name: "沪股通", date: "2026-11-14", amount: 100, leader: "" },
    { name: "深股通", date: "2026-11-14", amount: 90, leader: "" },
  ]), false);
});
