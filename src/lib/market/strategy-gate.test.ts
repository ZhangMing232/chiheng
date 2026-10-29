/**
 * 这个文件是干什么的：
 * 守住策略闸门的判决逻辑：t 值算法、停用/假释/恢复/冷却翻倍的每一条转换。
 *
 * 你需要知道的：
 * 这些标准是预先登记的（strategy-gate.ts 的 STRATEGY_GATE），测试锁死的就是
 * 「登记的标准真的被正确执行」。改标准要连测试一起改，这是故意的。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGate, tStat, clusterTStat, tradingDaysBetween, STRATEGY_GATE, type GateRecord } from "@/lib/market/strategy-gate";

/** 构造一组均值为 mean、标准差约 sd 的收益，长度 n。用于把 t 值打到目标区间。 */
function makeRets(n: number, mean: number, sd: number): number[] {
  // 正负交替的骨架 + 微调，保证样本标准差接近 sd、均值接近 mean
  const base = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? mean + sd : mean - sd));
  return base;
}

test("tStat：均值明显为负且波动小 → t 很大；正负相消 → t 接近 0", () => {
  const bad = tStat(makeRets(20, -0.03, 0.005));
  assert.ok(bad != null && bad < -5, `期望 t << -2，实际 ${bad}`);
  const flat = tStat(makeRets(20, 0, 0.01));
  assert.ok(flat != null && Math.abs(flat) < 0.01, `期望 t ≈ 0，实际 ${flat}`);
});

test("tStat：笔数太少或全部同值 → 不判决", () => {
  assert.equal(tStat([0.01, -0.02]), null);
  assert.equal(tStat(Array(20).fill(0.01)), null);
});

test("tradingDaysBetween：跨周末不算交易日", () => {
  // 2026-10-09 是周五，下一个交易日是 10-12（周一）
  assert.equal(tradingDaysBetween("2026-10-09", "2026-10-10"), 0);
  assert.equal(tradingDaysBetween("2026-10-09", "2026-10-12"), 1);
  assert.equal(tradingDaysBetween("2026-10-12", "2026-10-12"), 0);
});

test("无记录 + t ≤ −2 → 首次停用，冷却 10 天", () => {
  const decision = evaluateGate({ rets: makeRets(20, -0.03, 0.005), record: null, today: "2026-10-09" });
  assert.equal(decision.action, "disable");
  assert.equal(decision.next?.state, "disabled");
  assert.equal(decision.next?.cooldownDays, STRATEGY_GATE.cooldownDays);
  assert.equal(decision.next?.strikes, 1);
});

test("无记录 + 样本不足 20 笔 → 不判决（小样本是噪音）", () => {
  const decision = evaluateGate({ rets: makeRets(12, -0.05, 0.001), record: null, today: "2026-10-09" });
  assert.equal(decision.action, "none");
  assert.equal(decision.next, null);
});

test("停用中 + 冷却未满 → 继续停用", () => {
  const record: GateRecord = { state: "disabled", since: "2026-10-09", cooldownDays: 10, strikes: 1, reason: "x" };
  const decision = evaluateGate({ rets: [], record, today: "2026-10-16" }); // 5 个交易日
  assert.equal(decision.action, "none");
  assert.equal(decision.next, record);
});

test("停用中 + 冷却期满 → 假释，每天限 1 只", () => {
  const record: GateRecord = { state: "disabled", since: "2026-10-09", cooldownDays: 10, strikes: 1, reason: "x" };
  const decision = evaluateGate({ rets: [], record, today: "2026-10-23" }); // 10 个交易日
  assert.equal(decision.action, "parole");
  assert.equal(decision.next?.state, "paroled");
  assert.equal(decision.next?.since, "2026-10-23");
});

test("假释中 + 再次 t ≤ −2 → 停用，冷却翻倍到 20", () => {
  const record: GateRecord = { state: "paroled", since: "2026-10-23", cooldownDays: 10, strikes: 1, reason: "x" };
  const decision = evaluateGate({ rets: makeRets(20, -0.03, 0.005), record, today: "2026-11-06" });
  assert.equal(decision.action, "disable");
  assert.equal(decision.next?.cooldownDays, 20);
  assert.equal(decision.next?.strikes, 2);
});

test("假释中 + 冷却已 40 天再犯 → 封顶 40 不无限翻倍", () => {
  const record: GateRecord = { state: "paroled", since: "2026-10-23", cooldownDays: 40, strikes: 3, reason: "x" };
  const decision = evaluateGate({ rets: makeRets(20, -0.03, 0.005), record, today: "2026-11-06" });
  assert.equal(decision.action, "disable");
  assert.equal(decision.next?.cooldownDays, STRATEGY_GATE.maxCooldownDays);
});

test("假释中 + t > 0 → 恢复满仓，记录清除", () => {
  const record: GateRecord = { state: "paroled", since: "2026-10-23", cooldownDays: 10, strikes: 1, reason: "x" };
  const decision = evaluateGate({ rets: makeRets(20, 0.02, 0.005), record, today: "2026-11-06" });
  assert.equal(decision.action, "restore");
  assert.equal(decision.next, null);
});

test("假释中 + 样本还不够 → 维持假释，不加刑也不转正", () => {
  const record: GateRecord = { state: "paroled", since: "2026-10-23", cooldownDays: 10, strikes: 1, reason: "x" };
  const decision = evaluateGate({ rets: makeRets(6, -0.05, 0.001), record, today: "2026-10-30" });
  assert.equal(decision.action, "none");
  assert.equal(decision.next, record);
});

test("clusterTStat：笔数不足 8 返回 null，符号正确", () => {
  assert.equal(clusterTStat([-0.02, 0.01, -0.03], ["a", "b", "c"]), null);
  const rets = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? -0.03 : -0.05));
  const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const tc = clusterTStat(rets, dates);
  assert.ok(tc != null && tc < 0, `应负且有限：tc=${tc}`);
});

test("clusterTStat：同向收益挤在少数几天，t 比散开更保守（更接近 0）", () => {
  // 20 笔分 5 组，每组 4 笔同值（模拟同一天同向），组间小幅递减
  const rets = Array.from({ length: 20 }, (_, i) => -0.03 - Math.floor(i / 4) * 0.005);
  const spread = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const crowded = Array.from({ length: 20 }, (_, i) => `2026-10-${String(Math.floor(i / 4) + 1).padStart(2, "0")}`);
  const ts = clusterTStat(rets, spread);
  const tc = clusterTStat(rets, crowded);
  assert.ok(ts != null && tc != null, `都不该是 null：ts=${ts} tc=${tc}`);
  assert.ok(Math.abs(tc) < Math.abs(ts), `5 天聚类应比 20 天更保守：tc=${tc} ts=${ts}`);
});

test("evaluateGate：传了 dates 但天数不足 minDays → 不判决（交给回测判决）", () => {
  const rets = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? -0.03 : -0.05));
  const dates = [...Array(2).fill("2026-10-28"), ...Array(18).fill("2026-10-29")]; // 只有 2 天
  const decision = evaluateGate({ rets, dates, record: null, today: "2026-10-30" });
  assert.equal(decision.action, "none", "天数不足 minDays 不应判决");
});

test("evaluateGate：传了 dates 且天数够、聚类 t ≤ −2 → 停用", () => {
  // 构造 20 笔分属 20 天、每天一笔、均值明显为负 → 聚类 t 也会 ≤ −2
  const rets = Array.from({ length: 20 }, () => -0.04);
  const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const decision = evaluateGate({ rets, dates, record: null, today: "2026-11-01" });
  assert.equal(decision.action, "disable");
});
