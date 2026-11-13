/**
 * 实盘 vs 回测背离监控的守门测试。
 *
 * 保护的是「两个真相并存时必须诚实」这条纪律：26 笔的实盘不能拿去
 * 印证 2131 笔的回测，方向相反时必须明说「其中有一个在骗人」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareLiveVsBacktest, sideStats, MIN_SAMPLE, GAP_PP } from "./live-vs-backtest.ts";

const bt = (mean: number, n = 500) => ({ source: "回测", n, mean, winRate: 0.45, tStat: 1.16 });
const live = (mean: number, n = 100) => ({ source: "实盘", n, mean, winRate: 0.35, tStat: null });

test("🔴 实盘样本不足 → insufficient，不许拿小样本印证回测", () => {
  // 真实场景：回测 2131 笔，实盘只有 26 笔
  const r = compareLiveVsBacktest({ backtest: bt(-0.0041, 2131), live: live(0.0018, 26) });
  assert.equal(r.verdict, "insufficient");
  assert.match(r.reason, /样本不足/);
  assert.equal(r.gapPp, null, "样本不够时不报差值，避免被当成结论");
  assert.match(r.action!, /还差 4 笔/);
});

test("两侧都够样本且方向相反 → divergent，明说其中一个口径在骗人", () => {
  const r = compareLiveVsBacktest({ backtest: bt(-0.01), live: live(0.01) });
  assert.equal(r.verdict, "divergent");
  assert.match(r.reason, /方向相反/);
  assert.ok(r.action);
  assert.match(r.action!, /口径/);
});

test("同向且差距在阈值内 → aligned，两侧互相印证", () => {
  const r = compareLiveVsBacktest({ backtest: bt(0.005), live: live(0.006) });
  assert.equal(r.verdict, "aligned");
  assert.equal(r.action, null, "一致时不给动作建议");
});

test("同向但差距超阈值 → gap，提示核对是否同一批票", () => {
  const r = compareLiveVsBacktest({ backtest: bt(0.001), live: live((0.001 + GAP_PP / 100) * 2) });
  assert.equal(r.verdict, "gap");
  assert.match(r.reason, /差距大/);
  assert.match(r.action!, /交集/);
});

test("边界：差刚好等于阈值算 aligned（不超就不报）", () => {
  const r = compareLiveVsBacktest({ backtest: bt(0), live: live(GAP_PP / 100) });
  assert.equal(r.verdict, "aligned");
});

test("sideStats 算对均值与胜率，空数组不编 0", () => {
  const s = sideStats({ source: "x", returns: [0.01, -0.01, 0.02, 0.03] });
  assert.equal(s.n, 4);
  assert.ok(Math.abs(s.mean! - 0.0125) < 1e-9);
  assert.equal(s.winRate, 0.75);
  const empty = sideStats({ source: "x", returns: [] });
  assert.equal(empty.mean, null, "没有样本不能报 0");
  assert.equal(empty.winRate, null);
});

test("MIN_SAMPLE 是 30——低于它不下方向结论", () => {
  assert.equal(MIN_SAMPLE, 30);
  const r = compareLiveVsBacktest({ backtest: bt(0.01, 29), live: live(0.01, 100) });
  assert.equal(r.verdict, "insufficient");
});
