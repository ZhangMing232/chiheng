/**
 * 家族级方向学习的守门测试。
 *
 * 保护的核心主张：**池化能检出单变体检不出的方向**——
 * 这是方案 C 对 A/B 的全部优势所在。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { learnDirection, MIN_FAMILY_N, MIN_CHAMP_N, type TradeLike } from "./direction-learn.ts";

/** 造一笔。 */
const t = (variant: string | null, stopPct: number | null, ret: number, holdDays: number | null = null): TradeLike => ({
  variant,
  style: "value",
  stopPct,
  holdDays,
  ret,
});

test("🔴 池化能检出单变体检不出的方向（方案 C 的核心主张）", () => {
  // 场景：3 个止损=8 的变体各 4 笔（单变体 4 笔判不出），但 3 个都好于冠军
  // → 池化后止损=8 家族有 12 笔，方向清晰
  const trades: TradeLike[] = [];
  for (const v of ["value-stop8-a", "value-stop8-b", "value-stop8-c"]) {
    for (let i = 0; i < 4; i++) trades.push(t(v, 8, 0.01)); // 每个 +1%
  }
  // 冠军 12 笔均值 -1%
  for (let i = 0; i < 12; i++) trades.push(t(null, null, -0.01));

  const r = learnDirection(trades);
  const stop8 = r.families.find((f) => f.dim === "stopPct" && f.value === 8);
  assert.ok(stop8, "应有止损=8 家族");
  assert.equal(stop8.n, 12, "池化后 12 笔");
  assert.ok(stop8.excessPp! > 1, `池化超额 ${stop8.excessPp} 应 >1pp，单变体（4 笔）的统计功效做不到`);
  assert.ok(r.advice, "应产出方向建议");
  assert.match(r.advice!, /止损=8/);
  assert.match(r.advice!, /整体比冠军好/);
});

test("方向相反时给「别再往这个方向提」", () => {
  const trades: TradeLike[] = [];
  for (let i = 0; i < 10; i++) trades.push(t("v-a", 12, -0.02));
  for (let i = 0; i < 12; i++) trades.push(t(null, null, 0.005));
  const r = learnDirection(trades);
  const f = r.families.find((f) => f.dim === "stopPct" && f.value === 12);
  assert.ok(f && f.excessPp! < 0);
  assert.match(r.advice!, /跑输/);
  assert.match(r.advice!, /别再往这个方向提/);
});

test("超额落在阈值内 → 如实说看不出方向，不编", () => {
  const trades: TradeLike[] = [];
  for (let i = 0; i < 10; i++) trades.push(t("v-a", 8, 0.005));
  for (let i = 0; i < 12; i++) trades.push(t(null, null, 0.004)); // 差 0.1pp
  const r = learnDirection(trades);
  assert.match(r.advice!, /看不出方向/);
});

test("样本不足 → enoughData=false，advice=null（不编方向）", () => {
  const trades: TradeLike[] = [];
  for (let i = 0; i < 3; i++) trades.push(t("v-a", 8, 0.05)); // 变体才 3 笔
  for (let i = 0; i < 5; i++) trades.push(t(null, null, 0.0));
  const r = learnDirection(trades);
  assert.equal(r.enoughData, false);
  assert.equal(r.advice, null);
});

test("冠军侧也设门槛（MIN_CHAMP_N）", () => {
  const trades: TradeLike[] = [];
  for (let i = 0; i < 20; i++) trades.push(t("v-a", 8, 0.02));
  for (let i = 0; i < 5; i++) trades.push(t(null, null, 0.0)); // 冠军只有 5 笔
  const r = learnDirection(trades);
  assert.equal(r.enoughData, false, `冠军 ${r.totalChampN} < ${MIN_CHAMP_N}，不应下方向结论`);
});

test("无 holdDays/stopPct 字段的笔不进对应家族（不瞎分组）", () => {
  const trades: TradeLike[] = [{ variant: "v-x", style: "value", ret: 0.01 }]; // 什么参数都没有
  const r = learnDirection(trades);
  assert.equal(r.families.length, 0);
});

test("别的策略的冠军笔不算 value 的对照", () => {
  const trades: TradeLike[] = [];
  for (let i = 0; i < 15; i++) trades.push(t("v-a", 8, 0.02));
  for (let i = 0; i < 15; i++) trades.push({ variant: null, style: "breakout", ret: -0.05 }); // breakout 冠军
  const r = learnDirection(trades, { champStyle: "value" });
  assert.equal(r.totalChampN, 0, "breakout 的冠军笔不是 value 的对照");
});
