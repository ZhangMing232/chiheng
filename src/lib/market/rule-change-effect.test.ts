/**
 * 规则改动效果回验的守门测试。
 *
 * 这组测试保护的是「反思闭环的最后一环」：改完规则要能自己回答
 * 「这次改到底有没有用」。2026-11-14 之前这条链是断的——
 * earlyRejectDays 被来回摆 6 次（15→3→5→10→12→20→30）却从不回头验证。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRuleChangeEffect,
  MIN_DAYS_AFTER,
  MIN_TRADES_PER_SIDE,
  EFFECT_THRESHOLD_PP,
} from "./rule-change-effect.ts";

const base = { at: "2026-11-01T00:00:00.000Z", key: "earlyRejectDays", from: 15, to: 30 };

test("观察期不到 → pending，不许下结论", () => {
  const r = evaluateRuleChangeEffect({ ...base, before: [0.01], after: [0.02], daysAfter: MIN_DAYS_AFTER - 1 });
  assert.equal(r.verdict, "pending");
  assert.equal(r.delta, null);
  assert.match(r.reason, /未到.*观察期/);
});

test("样本不足 → inconclusive，不下结论（各需 ≥30 笔）", () => {
  // 实测教训：53 笔就能演出 +6.87pp 的假改善，所以下限设 30。
  const r = evaluateRuleChangeEffect({
    ...base,
    before: Array(29).fill(0.01),
    after: Array(29).fill(0.05),
    daysAfter: 20,
  });
  assert.equal(r.verdict, "inconclusive");
  assert.match(r.reason, /样本不足/);
});

test("改完明显变好 → effective", () => {
  const before = Array(30).fill(-0.01); // -1%
  const after = Array(30).fill(0.01); // +1%
  const r = evaluateRuleChangeEffect({ ...base, before, after, daysAfter: 20 });
  assert.equal(r.verdict, "effective");
  assert.ok(r.delta! > 0);
  assert.match(r.reason, /改善/);
  assert.equal(r.revertAdvice, null, "有效时不给回滚建议");
});

test("改完明显变差 → ineffective，并给回滚建议", () => {
  const before = Array(30).fill(0.01);
  const after = Array(30).fill(-0.01);
  const r = evaluateRuleChangeEffect({ ...base, before, after, daysAfter: 20 });
  assert.equal(r.verdict, "ineffective");
  assert.ok(r.delta! < 0);
  assert.match(r.reason, /恶化/);
  assert.ok(r.revertAdvice, "无效时要给回滚建议");
  assert.match(r.revertAdvice!, /earlyRejectDays/);
  assert.match(r.revertAdvice!, /30/);
  assert.match(r.revertAdvice!, /15/);
  assert.match(r.revertAdvice!, /人拍板/, "回滚必须写明要人拍板，不自动执行");
});

test("🔴 差值落在噪声区 → inconclusive，不瞎判好坏", () => {
  // 差 0.1pp < 阈值 0.3pp
  const before = Array(30).fill(0.0);
  const after = Array(30).fill(EFFECT_THRESHOLD_PP / 100 / 2);
  const r = evaluateRuleChangeEffect({ ...base, before, after, daysAfter: 20 });
  assert.equal(r.verdict, "inconclusive");
  assert.match(r.reason, /噪声区/);
});

test("边界：差值刚好超过阈值才算有效", () => {
  const before = Array(30).fill(0);
  const after = Array(30).fill((EFFECT_THRESHOLD_PP + 0.01) / 100);
  const r = evaluateRuleChangeEffect({ ...base, before, after, daysAfter: 20 });
  assert.equal(r.verdict, "effective");
});

test("平均收益算对（等差样本），不是拿首尾比", () => {
  const before = Array.from({length:30},(_,i)=>0.01+0.003*i); // 均值 0.055
  const after = Array(30).fill(0.05); // 均值 0.05
  const r = evaluateRuleChangeEffect({ ...base, before, after, daysAfter: 20 });
  assert.ok(Math.abs(r.beforeAvg! - (0.01 + 0.003 * 14.5)) < 1e-9, `实际 ${r.beforeAvg}`);
  assert.ok(Math.abs(r.afterAvg! - 0.05) < 1e-9);
});

test("回验报告带上原始 from/to，便于事后追", () => {
  const r = evaluateRuleChangeEffect({
    ...base,
    before: Array(30).fill(0.01),
    after: Array(30).fill(0.02),
    daysAfter: 20,
    now: "2026-11-20T00:00:00.000Z",
  });
  assert.equal(r.key, "earlyRejectDays");
  assert.equal(r.from, 15);
  assert.equal(r.to, 30);
  assert.equal(r.evaluatedAt, "2026-11-20T00:00:00.000Z");
  assert.equal(r.at, base.at);
});
