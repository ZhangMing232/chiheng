/**
 * 这个文件是干什么的：
 * 钉住 AI 额度闸（quota.ts）的规则——每档额度、词表外按 free、日期切换清零、
 * 失败调用也计数（bump 不退）、计数比判定松一格。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkQuota, nextQuotaState, quotaOf, type QuotaState } from "@/lib/auth/quota";

test("每档额度：免费 0，月付 2/5，年付 3/10，终身 5/20，admin 无限", () => {
  assert.deepEqual(quotaOf("free"), { evolve: 0, diagnose: 0 });
  assert.deepEqual(quotaOf("pro-monthly"), { evolve: 2, diagnose: 5 });
  assert.deepEqual(quotaOf("pro-yearly"), { evolve: 3, diagnose: 10 });
  assert.deepEqual(quotaOf("lifetime"), { evolve: 5, diagnose: 20 });
  assert.equal(quotaOf("admin").evolve, Infinity);
});

test("词表外的 plan / null / undefined 一律按 free（宁可误拦不可误放）", () => {
  for (const plan of ["不存在的档", null, undefined, ""]) {
    assert.deepEqual(quotaOf(plan), { evolve: 0, diagnose: 0 });
  }
});

test("checkQuota：达到上限就不 allowed；Infinity 永远 allowed", () => {
  assert.deepEqual(checkQuota("pro-monthly", "evolve", 1), { allowed: true, limit: 2, used: 1 });
  assert.deepEqual(checkQuota("pro-monthly", "evolve", 2), { allowed: false, limit: 2, used: 2 });
  assert.equal(checkQuota("admin", "evolve", 99999).allowed, true);
  assert.equal(checkQuota("free", "diagnose", 0).allowed, false);
});

test("nextQuotaState：同日累加，跨日清零后累加", () => {
  const day1: QuotaState = { date: "2026-10-21", evolve: 1, diagnose: 2 };
  assert.deepEqual(nextQuotaState(day1, "2026-10-21", "evolve"), { date: "2026-10-21", evolve: 2, diagnose: 2 });
  // 新的一天：先清零再 +1，不把昨天的用量带进今天。
  assert.deepEqual(nextQuotaState(day1, "2026-10-22", "evolve"), { date: "2026-10-22", evolve: 1, diagnose: 0 });
  // 没有历史（第一次用）：当天从 1 起。
  assert.deepEqual(nextQuotaState(null, "2026-10-22", "diagnose"), { date: "2026-10-22", evolve: 0, diagnose: 1 });
});

test("bump 允许超 1：闸在 assert 那边，记账不能丢并发下的第二次", () => {
  const full: QuotaState = { date: "2026-10-21", evolve: 2, diagnose: 0 };
  // 已用 2/2，再来一次记账变 3——assertAIQuota 保证走不到这；走到了也如实记。
  assert.equal(nextQuotaState(full, "2026-10-21", "evolve").evolve, 3);
});
