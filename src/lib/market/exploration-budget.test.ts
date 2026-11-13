/**
 * 探索预算判据的守门测试。
 *
 * 保护的核心纪律：**「还没试够」和「试了没用」必须分开**。
 * 20 次尝试前说「这套没用」等于刚开局就认输；但连续 45 天零产出还继续烧，
 * 就是系统在无声无息地空转。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateExplorationBudget, attemptsFromQueue, BUDGET_RULE, type ExplorationAttempt } from "./exploration-budget.ts";

const TODAY = "2026-11-14";
const mk = (n: number, daysAgo: number, outcome: ExplorationAttempt["outcome"] = "rejected"): ExplorationAttempt[] => {
  const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - daysAgo * 86_400_000).toISOString().slice(0, 10);
  return Array.from({ length: n }, () => ({ at: d, channel: "factor" as const, outcome }));
};

test("尝试太少 → insufficient，不许刚开局就判死", () => {
  const r = evaluateExplorationBudget(mk(5, 3), TODAY);
  assert.equal(r.verdict, "insufficient");
  assert.match(r.reason, /还没试够/);
  assert.equal(r.action, null);
});

test("有产出 → healthy，并报命中率", () => {
  const r = evaluateExplorationBudget([...mk(18, 5), ...mk(4, 3, "promoted")], TODAY);
  assert.equal(r.verdict, "healthy");
  assert.ok(r.hitRate! > 0);
  assert.match(r.reason, /产出 4 个/);
});

test("🔴 连续 21 天零产出 → cooldown，建议降频但不停止", () => {
  // 窗口内 30 次尝试，最后一次产出在 25 天前
  const r = evaluateExplorationBudget([...mk(30, 10), ...mk(2, 25, "promoted")], TODAY);
  assert.equal(r.verdict, "cooldown");
  assert.match(r.reason, /建议降频/);
  assert.match(r.action!, /只跑因子层/);
});

test("🔴 连续 45 天零产出 → halt，停机等人拍板", () => {
  // 窗口内 25 次尝试（够 minAttempts），最早的尝试在 60 天前 → 零产出 60 天
  const r = evaluateExplorationBudget([...mk(25, 10), ...mk(5, 60)], TODAY);
  assert.equal(r.verdict, "halt");
  assert.match(r.reason, /停机线/);
  assert.match(r.action!, /等人拍板/);
  assert.match(r.action!, /不删任何数据/, "停机不能是破坏性的");
});

test("边界：刚过 cooldown 线不算 halt", () => {
  const r = evaluateExplorationBudget([...mk(30, 5), ...mk(1, BUDGET_RULE.cooldownAfterDays, "promoted")], TODAY);
  assert.equal(r.verdict, "cooldown");
});

test("边界：刚过 halt 线就 halt", () => {
  const r = evaluateExplorationBudget([...mk(30, 5), ...mk(1, BUDGET_RULE.haltAfterDays, "promoted")], TODAY);
  assert.equal(r.verdict, "halt");
});

test("daysSinceLastHit 算对（今天有产出 = 0 天）", () => {
  const r = evaluateExplorationBudget([...mk(20, 5), ...mk(1, 0, "promoted")], TODAY);
  assert.equal(r.daysSinceLastHit, 0);
});

test("从没产出过 → 从第一次尝试起算，能正确判 halt", () => {
  // 窗口内要有 ≥20 次尝试（否则 insufficient），所以让尝试集中在窗口内但跨度足够
  const r = evaluateExplorationBudget([...mk(25, 5), ...mk(5, 60)], TODAY);
  assert.equal(r.verdict, "halt");
  assert.equal(r.daysSinceLastHit, null, "从没产出时不给 0，给 null");
});

test("attemptsFromQueue 映射三种通道状态", () => {
  const out = attemptsFromQueue({
    factorQueue: [
      { id: "a", status: "tombstone", lastRunAt: "2026-11-01T00:00:00Z" },
      { id: "b", status: "passed", createdAt: "2026-10-20T00:00:00Z" },
      { id: "c", status: "testing", createdAt: "2026-11-10T00:00:00Z" },
    ],
    genome: [
      { id: "g1", status: "rejected", since: "2026-11-05" },
      { id: "g2", status: "promoted", since: "2026-11-08" },
    ],
  });
  assert.equal(out.length, 5);
  assert.equal(out.filter((a) => a.outcome === "promoted").length, 2);
  assert.equal(out.filter((a) => a.channel === "genome").length, 2);
  // 日期不合法的记录被丢掉，不拿空串瞎算
  const bad = attemptsFromQueue({ factorQueue: [{ id: "x", status: "passed", createdAt: "" }], genome: [] });
  assert.equal(bad.length, 0);
});
