/**
 * 这个文件是干什么了：
 * 钉住回测曲线的口径。算法抄自 Vibe-Research 的 event_study.py
 * （cumsum 累计 + 逐列平均 + 「少于 8 次不给平均」的纪律），
 * 但**赤轨的口径有三处不一样**，测试要把它们钉住，别被"抄"抄糊了。
 *
 * 1. 等权累加不是复利（账本不记仓位大小，是诚实口径）——曲线不许读成"净值翻倍"
 * 2. 回撤的 peak 从 0 起算，否则第一天下跌会被算成 100% 回撤
 * 3. 成交日不够的月份不画，并返回被挡掉的月份让页面说清
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_DAYS_FOR_BAR,
  barsToShow,
  buildCurve,
  curveSummary,
  monthlyBars,
  yearlyBars,
  type DailyPoint,
} from "@/lib/market/backtest-curve";

function day(date: string, ret: number, n = 1): DailyPoint {
  return { date, ret, n };
}

test("累计曲线是日收益累加，不是复利（口径要标在页面上）", () => {
  const curve = buildCurve([day("2026-01-05", 0.01), day("2026-01-06", 0.01), day("2026-01-07", 0.01)]);
  assert.deepEqual(curve.cum, [0.01, 0.02, 0.03], "等权累加：1%+1%+1% = 3%，不是 1.01³");
  assert.deepEqual(curve.dates, ["2026-01-05", "2026-01-06", "2026-01-07"]);
});



test("基准缺的日子不编 0 充数——但超额曲线要短得有道理", () => {
  const withBench = buildCurve([day("2026-01-05", 0.01), day("2026-01-06", 0.02)], [day("2026-01-05", 0.005)]);
  assert.deepEqual(withBench.cumBench, [0.005, 0.005], "第二天没基准就不加，不是补 0 假装有");
});

test("空序列给空曲线，不崩", () => {
  const curve = buildCurve([]);
  assert.deepEqual(curve.cum, []);
  assert.equal(curveSummary(curve, []), null, "没数据时给 null，不给 0——0 会被读成「不赚不亏」");
});

test("🔴 回撤是绝对回落（百分点），不是比例——比例会在 peak 很小时爆炸", () => {
  // 这条钉 2026-10-14 的真 bug：第一版用 (peak-cum)/peak，peak 只有 +5% 而 cum
  // 掉到 -139% 时算出「最大回撤 681.5%」。等权累加没有"净值"概念，只能用百分点。
  const curve = buildCurve([day("2026-01-05", 0.05), day("2026-01-06", -0.5), day("2026-01-07", -0.944)]);
  assert.deepEqual(curve.peak, [0.05, 0.05, 0.05]);
  assert.deepEqual(curve.dd, [0, 0.5, 1.444], "cum 依次 5% → -45% → -139.4%，从峰值 5% 分别回落 0 / 50 / 144.4 个百分点");
  assert.ok(curve.dd.every((v) => v < 10), "回撤不该出现几百个百分点的荒谬值");
});

test("回撤不为负，peak 从 0 起（没创新高就是 0）", () => {
  const curve = buildCurve([day("2026-01-05", -0.02), day("2026-01-06", 0.03), day("2026-01-07", -0.01)]);
  assert.deepEqual(curve.peak, [0, 0.01, 0.01]);
  assert.ok(curve.dd.every((v) => v >= 0), "回撤不为负");
});

test("月度按等权平均，不累加", () => {
  const bars = monthlyBars([
    day("2026-01-05", 0.01),
    day("2026-01-06", 0.03),
    day("2026-02-02", -0.01),
  ]);
  assert.deepEqual(bars, [
    { key: "2026-01", ret: 0.02, n: 2 },
    { key: "2026-02", ret: -0.01, n: 1 },
  ]);
});

test("年度口径和月度一致", () => {
  const bars = yearlyBars([day("2025-11-03", 0.01), day("2026-01-05", 0.02), day("2026-03-02", 0.04)]);
  assert.deepEqual(bars, [
    { key: "2025", ret: 0.01, n: 1 },
    { key: "2026", ret: 0.03, n: 2 },
  ]);
});

test("成交日不够的月份不画，并说清挡了哪几个月", () => {
  const bars = [
    { key: "2026-01", ret: 0.02, n: 5 },
    { key: "2026-02", ret: 0.05, n: 1 },
    { key: "2026-03", ret: -0.01, n: 0 },
  ];
  const { show, hidden } = barsToShow(bars);
  assert.deepEqual(show.map((b) => b.key), ["2026-01"]);
  assert.deepEqual(hidden, ["2026-02", "2026-03"]);
  assert.ok(MIN_DAYS_FOR_BAR >= 3, "门槛至少 3 个成交日——几次的平均不是平均");
});

test("摘要：总累计/最大回撤/胜出的月份", () => {
  const daily = [day("2026-01-05", 0.01), day("2026-01-06", 0.02), day("2026-02-02", -0.03)];
  const curve = buildCurve(daily);
  const s = curveSummary(curve, monthlyBars(daily));
  assert.ok(s);
  assert.equal(s!.total, 0);
  assert.ok(s!.maxDd > 0, "最大回撤是百分点，不是比例");
  assert.equal(s!.winMonths, 1, "1 月赚、2 月亏");
  assert.equal(s!.months, 2);
});

test("曲线长度和输入一致（图不能比数据短）", () => {
  const daily = [day("2026-01-05", 0.01), day("2026-01-06", 0.02)];
  const curve = buildCurve(daily);
  assert.equal(curve.cum.length, daily.length);
  assert.equal(curve.dd.length, daily.length);
  assert.equal(curve.peak.length, daily.length);
});
