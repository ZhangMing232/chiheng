/**
 * robustness.ts 的单测。算法移植自 Vibe-Trading v0.1.16，这里的期望值
 * 不是拍脑袋：正态 cdf/ppf 用已知数值点，PSR/期望极值用手算得动的特例，
 * bootstrap/walk-forward 用确定性种子钉死可复现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapSharpeCI,
  dsr,
  expectedMaxSharpe,
  kurtosisOf,
  mean,
  mulberry32,
  normalCdf,
  normalPpf,
  paramSensitivity,
  perPeriodSharpe,
  psr,
  sharpe,
  skewness,
  std,
  walkForward,
  type DailyPoint,
} from "./robustness.ts";

test("normalCdf 已知值（A&S 26.2.17 精度 7.5e-8，留 1e-5 余量）", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1) - 0.841344746) < 1e-5);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.0) - (1 - normalCdf(1.0))) < 1e-9);
  assert.ok(normalCdf(10) === 1 && normalCdf(-10) === 0);
});

test("normalPpf 与 normalCdf 互逆", () => {
  for (const p of [0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999]) {
    const x = normalPpf(p);
    assert.ok(Math.abs(normalCdf(x) - p) < 1e-4, `p=${p} roundtrip 偏差过大`);
  }
  assert.throws(() => normalPpf(0));
  assert.throws(() => normalPpf(1));
});

test("normalPpf 已知分位点", () => {
  assert.ok(Math.abs(normalPpf(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(normalPpf(0.5)) < 1e-9);
});

test("mulberry32 确定性 + 值域", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const va = a();
    assert.equal(va, b());
    assert.ok(va >= 0 && va < 1);
  }
  // 不同种子序列必须不同
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test("sharpe：常数序列不爆炸，符号正确", () => {
  assert.equal(sharpe([0.01, 0.01, 0.01]), 0); // 无偏方差 0 → 0（epsilon 护住）
  const up = Array.from({ length: 60 }, () => 0.01);
  const dn = Array.from({ length: 60 }, () => -0.01);
  assert.ok(sharpe(up) > 0);
  assert.ok(sharpe(dn) < 0);
  assert.ok(Math.abs(sharpe(dn) + sharpe(up)) < 1e-9);
});

test("skewness / kurtosisOf：对称分布偏度 0，厚尾峰度 > 3", () => {
  const sym = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  assert.ok(Math.abs(skewness(sym)) < 1e-9);
  const fat = [0, 0, 0, 0, 0, 0, 0, 0, 0, 10]; // 一個极端值 → 正偏厚尾
  assert.ok(skewness(fat) > 0);
  assert.ok(kurtosisOf(fat) > 3);
  assert.ok(Math.abs(kurtosisOf(sym) - 1.8) < 0.3); // 均匀分布超额≈-1.2 → 非超额≈1.8
});

test("walkForward：段切分与一致性", () => {
  // 10 天，每天 +0.001 → 切 2 段各 5 天，全盈利
  const daily: DailyPoint[] = Array.from({ length: 10 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, ret: 0.001 }));
  const r = walkForward(daily, 2);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.nWindows, 2);
  assert.equal(r.windows.length, 2);
  assert.equal(r.windows[0]!.bars, 5);
  assert.equal(r.windows[1]!.bars, 5);
  assert.equal(r.profitableWindows, 2);
  assert.equal(r.consistencyRate, 1);
  assert.ok(Math.abs(r.windows[0]!.ret - 0.005) < 1e-9);
  assert.equal(r.windows[0]!.start, "2026-01-01");
  assert.equal(r.windows[1]!.end, "2026-01-10");

  // 前半赚后半亏 → 一致性 0.5
  const half: DailyPoint[] = daily.map((d, i) => ({ ...d, ret: i < 5 ? 0.001 : -0.001 }));
  const r2 = walkForward(half, 2);
  assert.ok(!("error" in r2) && r2.consistencyRate === 0.5);

  // 错误路径
  assert.ok("error" in walkForward(daily, 0));
  assert.ok("error" in walkForward(daily.slice(0, 3), 5));
});

test("walkForward：回撤以窗口起点为参照（学 Vibe 的 cummax 含起点）", () => {
  // 第 2 段 [-0.01, 0]：从窗口起点 1 跌到 0.99 → 段内回撤 -0.01
  const daily: DailyPoint[] = [
    { date: "d1", ret: 0 },
    { date: "d2", ret: 0.02 },
    { date: "d3", ret: -0.01 },
    { date: "d4", ret: 0 },
  ];
  const r = walkForward(daily, 2);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  const w2 = r.windows[1]!;
  assert.ok(w2.maxDrawdown < 0);
  assert.ok(Math.abs(w2.maxDrawdown - -0.01) < 1e-9);
  // 第 1 段 [0, 0.02] 一路创新高 → 无回撤
  assert.equal(r.windows[0]!.maxDrawdown, 0);
});

test("bootstrapSharpeCI：确定性、强正收益 P(>0) 高", () => {
  const rets = Array.from({ length: 120 }, (_, i) => 0.002 + (i % 7 === 0 ? -0.003 : 0.001));
  const a = bootstrapSharpeCI(rets, { draws: 500, seed: 42 });
  const b = bootstrapSharpeCI(rets, { draws: 500, seed: 42 });
  assert.deepEqual(a, b); // 同种子同结果
  assert.ok(!("error" in a));
  if ("error" in a) return;
  assert.equal(a.draws, 500);
  assert.ok(a.ciLow < a.observedSharpe && a.observedSharpe < a.ciHigh);
  assert.ok(a.probPositive > 0.95, `强正收益序列 P(夏普>0) 应很高，得到 ${a.probPositive}`);
  // 换种子结果应接近（同一分布；该序列夏普~26，给 2 的绝对余量）
  const c = bootstrapSharpeCI(rets, { draws: 500, seed: 7 });
  if (!("error" in c)) assert.ok(Math.abs(c.ciLow - a.ciLow) < 2);
});

test("bootstrapSharpeCI：样本太少报错", () => {
  assert.ok("error" in bootstrapSharpeCI([0.01, 0.02], {}));
});

test("PSR：高夏普大样本 → 接近 1；零夏普 → 0.5", () => {
  // per-period（日频）夏普 0.15，250 天 → SR·√T ≈ 2.35
  const srDaily = 0.15;
  const p = psr(srDaily, 250, 0, 0, 3);
  assert.ok(p > 0.99, `强信号 PSR 应接近 1，得到 ${p}`);
  const mid = psr(0, 250, 0, 0, 3);
  assert.ok(Math.abs(mid - 0.5) < 1e-9);
  // 负偏让同样的夏普更不可信
  const negSkew = psr(srDaily, 250, 0, -2, 5);
  assert.ok(negSkew < p);
  assert.throws(() => psr(srDaily, 10)); // 观测太少
  assert.throws(() => psr(srDaily, 250, 0, 0, 0.5)); // 非超额峰度不能 <1
});

test("expectedMaxSharpe：单调、单试为 0、std=0 为 0", () => {
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
  assert.equal(expectedMaxSharpe(10, 0), 0);
  const a = expectedMaxSharpe(10, 0.001);
  const b = expectedMaxSharpe(100, 0.001);
  const c = expectedMaxSharpe(1000, 0.001);
  assert.ok(0 < a && a < b && b < c, `运气线应随试验次数递增：${a} ${b} ${c}`);
});

test("dsr：搜得少能活，搜得多同样的夏普活不了", () => {
  // per-period（日频）夏普 0.15（≈年化 2.4），250 天，正态无偏
  const good = dsr(0.15, 5, 250, 0.02);
  const lucky = dsr(0.15, 500, 250, 0.02);
  assert.ok(good.dsr > lucky.dsr);
  assert.ok(good.survives, `试 5 个挑出 0.15 应能活，DSR=${good.dsr.toFixed(3)}`);
  assert.ok(!lucky.survives, `试 500 个挑出 0.15 应是运气，DSR=${lucky.dsr.toFixed(3)}`);
  assert.ok(lucky.expectedMaxSharpe > good.expectedMaxSharpe);
});

test("paramSensitivity：邻域变号 → 脆弱", () => {
  // 指标对 params.x 敏感：x=10 时 +1，邻域有负值 → fragile
  const r = paramSensitivity({ x: 10 }, [{ x: 9 }, { x: 11 }, { x: 8 }], (p) => (p.x === 10 ? 1 : p.x - 15));
  assert.equal(r.baseMetric, 1);
  assert.ok(r.min < 0);
  assert.ok(r.fragile);
  // 平台型参数：邻域指标稳定为正 → 不脆弱
  const flat = paramSensitivity({ x: 10 }, [{ x: 9 }, { x: 11 }], () => 0.5);
  assert.ok(!flat.fragile);
  assert.equal(flat.results.length, 2);
});

test("perPeriodSharpe：t/√n，n=0 不爆炸", () => {
  assert.ok(Math.abs(perPeriodSharpe(2, 100) - 0.2) < 1e-12);
  assert.equal(perPeriodSharpe(2, 0), 0);
  assert.equal(perPeriodSharpe(-3, 9), -1);
});

test("mean/std 基础行为", () => {
  assert.equal(mean([]), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(std([1]), 0);
  assert.ok(Math.abs(std([1, 2, 3]) - 1) < 1e-9);
});
