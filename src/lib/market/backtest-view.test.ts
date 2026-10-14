/**
 * 这个文件是干什么的：
 * 钉住回测页的两条纪律。
 *
 * 1. **口径不同的两次运行不可比**，页面必须把差异摊开（成本口径改过一次，
 *    0.102% → 0.302%，旧数字全部失效）
 * 2. **|t| < 2 的超额等于没测出来**，排序时沉底、并单独列出来
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { comparable, envDiff, runSummary, styleRows, untested } from "@/lib/market/backtest-view";
import type { BacktestEnv, BacktestRun, BacktestStyleStat } from "@/lib/market/backtest-runs";

function env(over: Partial<BacktestEnv> = {}): BacktestEnv {
  return {
    start: "2025-09-18",
    end: "2026-09-30",
    days: 250,
    sample: 300,
    covered: 296,
    fillMode: "b",
    fee: 0.00302,
    turnoverGate: true,
    stopPct: null,
    bench300: -0.051,
    ...over,
  };
}

function style(over: Partial<BacktestStyleStat> = {}): BacktestStyleStat {
  return {
    key: "rebound",
    label: "中期反转",
    trades: 2270,
    winRate: 0.38,
    avgRet: -0.0003,
    benchAvg: -0.0019,
    alpha: 0.0016,
    tStat: 1.16,
    beatRate: 0.4,
    avgHold: 10,
    worstStreak: 29,
    drawdown: 0.12,
    ...over,
  };
}

function run(over: Partial<BacktestRun> = {}): BacktestRun {
  return { ranAt: "2026-10-12T09:00:00.000Z", ranDate: "2026-10-12", env: env(), styles: [style()], note: null, ...over };
}

test("口径一致 = 可比", () => {
  assert.deepEqual(envDiff(env(), env()), []);
  assert.equal(comparable(run(), run()), true);
});

test("成本口径不同必须点出来（0.102% → 0.302% 那次）", () => {
  const diff = envDiff(env(), env({ fee: 0.00102 }));
  assert.equal(diff.length, 1);
  assert.match(diff[0]!, /0\.302% vs 0\.102%/);
  assert.equal(comparable(run(), run({ env: env({ fee: 0.00102 }) })), false);
});

test("区间/撮合/闸门/样本量不同都算不可比", () => {
  assert.match(envDiff(env(), env({ end: "2026-06-30" }))[0]!, /区间/);
  assert.match(envDiff(env(), env({ fillMode: "a" }))[0]!, /撮合/);
  assert.match(envDiff(env(), env({ turnoverGate: false }))[0]!, /换手率闸/);
  assert.match(envDiff(env(), env({ covered: 60 }))[0]!, /取到日线 296 只 vs 60 只/);
  assert.match(envDiff(env(), env({ stopPct: 5 }))[0]!, /止损/);
});

test("按超额排序：负的沉底", () => {
  const r = run({
    styles: [style({ key: "a", alpha: -0.002 }), style({ key: "b", alpha: 0.003 }), style({ key: "c", alpha: 0 })],
  });
  assert.deepEqual(styleRows(r, "alpha").map((s) => s.key), ["b", "c", "a"]);
});

test("按 t 值排序：|t| < 2 的沉底，没测出来的超额不排前面", () => {
  const r = run({
    styles: [
      style({ key: "big", alpha: 0.01, tStat: 0.5 }), // 超额最大但没测出来
      style({ key: "real", alpha: 0.002, tStat: 3.1 }),
    ],
  });
  assert.deepEqual(styleRows(r, "tStat").map((s) => s.key), ["real", "big"]);
});

test("untested 把 |t| < 2 的挑出来", () => {
  const r = run({ styles: [style({ key: "a", tStat: 1.16 }), style({ key: "b", tStat: -2.4 })] });
  assert.deepEqual(untested(r).map((s) => s.key), ["a"]);
});

test("样本小于 50 只要标 thin：结论不足以做统计", () => {
  assert.equal(runSummary(run()).thin, false);
  const thin = runSummary(run({ env: env({ covered: 30 }) }));
  assert.equal(thin.thin, true);
  assert.match(thin.envText, /样本 30 只/);
});

test("摘要里带上口径，列表页能看出这次跑的是什么", () => {
  const s = runSummary(run({ env: env({ fillMode: "a", fee: 0.00102, turnoverGate: false }) }));
  assert.match(s.envText, /撮合 a/);
  assert.match(s.envText, /成本 0\.102%/);
  assert.match(s.envText, /换手闸关/);
  assert.match(s.text, /同期沪深300 -5\.1%/);
});