/**
 * 这个文件是干什么的：
 * 守住挑战者判决逻辑：Welch t 的方向和量级、转正/淘汰/inconclusive 的每条转换。
 *
 * 你需要知道的：
 * 标准预先登记在 challenger.ts 的 CHALLENGER_RULE，测试锁死的是
 * 「登记的标准真的被正确执行」。改标准要连测试一起改，这是故意的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHALLENGER_RULE, judgeChallenger, welchT } from "@/lib/market/challenger";

/** 交替骨架：均值≈mean、样本标准差≈sd 的 n 笔收益。 */
function makeRets(n: number, mean: number, sd: number): number[] {
  return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? mean + sd : mean - sd));
}

test("welchT：a 明显好于 b → 正大数；反过来 → 负；样本不足 → null", () => {
  const good = welchT(makeRets(30, 0.02, 0.004), makeRets(30, 0, 0.004));
  assert.ok(good != null && good > 5, `期望 t >> 0，实际 ${good}`);
  const bad = welchT(makeRets(30, 0, 0.004), makeRets(30, 0.02, 0.004));
  assert.ok(bad != null && bad < -5, `期望 t << 0，实际 ${bad}`);
  assert.equal(welchT([0.01], [0.02, 0.03]), null);
});

test("任一方样本不足 → 不判决", () => {
  const d = judgeChallenger(makeRets(30, 0, 0.01), makeRets(12, 0.05, 0.001));
  assert.equal(d.action, "none");
});

test("挑战者显著更好 → 转正（t≥1.5 且均值更高）", () => {
  const d = judgeChallenger(makeRets(40, 0, 0.01), makeRets(35, 0.015, 0.004));
  assert.equal(d.action, "promote");
});

test("均值更高但不够显著 → 不转正", () => {
  // 差 0.4 个点、波动 2 个点、35 笔：t≈0.86，够不上 promoteT
  const d = judgeChallenger(makeRets(40, 0, 0.02), makeRets(35, 0.004, 0.02));
  assert.equal(d.action, "none");
});

test("挑战者自身 t≤−2 → 淘汰，哪怕样本还不够 minTrades 之外的一切", () => {
  const d = judgeChallenger(makeRets(40, 0.01, 0.01), makeRets(35, -0.03, 0.004));
  assert.equal(d.action, "reject");
});

test("跑满 maxTrades 仍不分胜负 → inconclusive 停跑", () => {
  const champ = makeRets(60, 0.002, 0.01);
  const chal = makeRets(CHALLENGER_RULE.maxTrades, 0.002, 0.01);
  const d = judgeChallenger(champ, chal);
  assert.equal(d.action, "inconclusive");
});

// ── bucketReturns：判决和 UI 进度共用的分桶口径 ───────────────────

test("bucketReturns：按 style:variant 分桶，未平仓/不可信天/无风格不入桶", async () => {
  const { bucketReturns } = await import("@/lib/market/challenger");
  const days = [
    {
      signalTime: "09:35", // 可信（早盘后）
      trades: [
        { entry: 10, exit: 11, style: "breakout", variant: "c_a" },       // +10% 进 breakout:c_a
        { entry: 10, exit: 9.5, style: "breakout" },                        // 冠军桶 breakout:champion
        { entry: 10, exit: null, style: "rebound", variant: "c_b" },        // 未平仓，不入
        { entry: 10, exit: 12, style: "rebound", variant: "champion" },     // 显式 champion → 冠军桶
      ],
    },
    { signalTime: "15:05", trades: [{ entry: 10, exit: 11, style: "breakout", variant: "c_a" }] }, // 收盘后记的（不可信天），整桶跳过
    { signalTime: "09:35", trades: [{ entry: 10, exit: 11, style: "已退市旧策略" }] }, // 无风格不入
  ];
  const buckets = bucketReturns(days);
  assert.equal((buckets.get("breakout:c_a") ?? []).length, 1);
  assert.equal((buckets.get("breakout:champion") ?? []).length, 1);
  assert.equal((buckets.get("rebound:champion") ?? []).length, 1);
  assert.equal(buckets.has("rebound:c_b"), false);
});
