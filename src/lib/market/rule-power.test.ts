/**
 * 判决规则统计功效校验的守门测试。
 *
 * 保护的核心结论（2026-11-14 用真实数据算出）：
 * 账本单笔收益标准差 10.05%，挑战者 minTrades=12 →
 * 最小可检出均差 11.49pp，而这类调整的典型效果只有 3pp。
 * **攒够样本也判不出来**——这是机制的设计缺陷，不是执行问题。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { minDetectableEffectPp, evaluateRulePower, TYPICAL_EFFECT_PP } from "./rule-power.ts";

const SD = 0.1005; // 账本实测标准差 10.05%

test("🔴 真实参数复现：12 笔 + 10.05% 标准差 → 最小可检出 11.5pp 左右", () => {
  const pp = minDetectableEffectPp({ perSide: 12, sd: SD });
  assert.ok(pp != null);
  // 理论值 (1.96+0.8416)*sqrt(2/12)*10.05% ≈ 11.49pp
  assert.ok(pp! > 11 && pp! < 12, `实际 ${pp}`);
});

test("🔴 12 笔判定为功效不足，并指出「攒够也判不出」", () => {
  const r = evaluateRulePower({ perSide: 12, sd: SD, thresholdT: 1.5 });
  assert.equal(r.verdict, "underpowered");
  assert.match(r.reason, /攒够样本也判不出来/);
  assert.ok(r.minDetectablePp > TYPICAL_EFFECT_PP * 3);
});

test("门槛低于 2 时额外提示假阳性风险", () => {
  const r = evaluateRulePower({ perSide: 12, sd: SD, thresholdT: 1.5 });
  assert.match(r.advice!, /噪声当信号/);
  assert.match(r.advice!, /≥2/);
});

test("门槛合理时只谈样本量，不冤枉门槛", () => {
  const r = evaluateRulePower({ perSide: 12, sd: SD, thresholdT: 2.0 });
  assert.match(r.advice!, /问题只在样本量/);
});

test("样本够了 → adequate，不给建议", () => {
  // 每侧 150 笔：minDetectable ≈ (2.8)*sqrt(2/150)*10.05% ≈ 3.25pp，仍略高于 3
  const r = evaluateRulePower({ perSide: 200, sd: SD, thresholdT: 2.0 });
  assert.equal(r.verdict, "adequate");
  assert.equal(r.advice, null);
});

test("建议的样本量能真的达标（反算验证）", () => {
  const r = evaluateRulePower({ perSide: 12, sd: SD, thresholdT: 1.5 });
  const needN = Number(/约 (\d+) 笔/.exec(r.advice!)![1]);
  const check = minDetectableEffectPp({ perSide: needN, sd: SD });
  assert.ok(check! <= TYPICAL_EFFECT_PP + 0.2, `反算 ${needN} 笔应能检出 ≤${TYPICAL_EFFECT_PP}pp，实际 ${check}`);
});

test("无效输入不编数字", () => {
  assert.equal(minDetectableEffectPp({ perSide: 1, sd: SD }), null);
  assert.equal(minDetectableEffectPp({ perSide: 12, sd: 0 }), null);
  const r = evaluateRulePower({ perSide: 0, sd: SD, thresholdT: 2 });
  assert.equal(r.verdict, "unknown");
});

test("标准差越大，需要的样本越多（单调性）", () => {
  const a = evaluateRulePower({ perSide: 12, sd: 0.05, thresholdT: 2 });
  const b = evaluateRulePower({ perSide: 12, sd: 0.15, thresholdT: 2 });
  assert.ok(b.minDetectablePp > a.minDetectablePp);
});
