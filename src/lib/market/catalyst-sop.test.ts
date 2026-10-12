/**
 * 这个文件是干什么的：
 * 钉住裁决点推导——**每份报告至少三个、每个四要素齐全、没有证据的阶段不出裁决点**。
 *
 * 「四要素齐全」是它 SOP 的核心：只有观察对象没有时点的裁决点是废话
 * （「关注后续进展」），只有阈值没有触发后果的是空话。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CATALYST_SOP, decisionPointsFrom, type DecisionPoint } from "@/lib/market/catalyst-sop";
import { runResearch } from "@/lib/market/research";
import { valuationPosition } from "@/lib/market/pe-history";
import type { Quote } from "@/lib/market/types";

function quote(): Quote {
  return {
    id: "sh600519", code: "600519", name: "贵州茅台", board: "sh", price: 1288, chg: 1.98,
    pe: 19.77, pb: 6.41, cap: 16101, floatCap: 16101, turnover: 0.25, volRatio: 1.03, amp: 2.14,
    d5: 3.55, d10: 1, d20: -3.16, d60: 6.89, ytd: -4.53, inflow: 14850, amount: 404300, st: false,
  };
}

function fourComplete(p: DecisionPoint) {
  assert.ok(p.object.length > 0, "缺观察对象");
  assert.ok(p.threshold.length > 0, "缺阈值/方向");
  assert.ok(p.source.length > 0, "缺来源");
  assert.ok(p.nextAt.length > 0, "缺下一次公开时点");
  assert.ok(p.effect.length > 0, "缺触发后判断怎么变");
}

test("正常一份报告至少三个裁决点，且四要素齐全", () => {
  const points = decisionPointsFrom(runResearch({ quote: quote(), articles: [] }).stages);
  assert.ok(points.length >= 3, `只有 ${points.length} 个，少于它要求的 3 个`);
  for (const p of points) fourComplete(p);
});

test("没有证据的阶段不出对应裁决点", () => {
  // 没资讯 → catalyst 阶段没证据 → 不该出「否决性公告」那条
  const points = decisionPointsFrom(runResearch({ quote: quote(), articles: [] }).stages);
  assert.ok(!points.some((p) => p.from === "catalyst"), "没证据的阶段不该出裁决点");
});

test("有估值序列时出分位裁决点", () => {
  const series = Array.from({ length: 60 }, (_, i) => ({
    date: `d${i}`, close: 10 + i, peTTM: i + 1, pbMRQ: (i + 1) / 10, psTTM: 1, turn: 1, isST: false,
  }));
  const val = valuationPosition({
    code: "600519", symbol: "sh.600519", source: "baostock", adjust: "none",
    fetchedAt: "2026-10-12", window: { from: "a", to: "b" },
    counts: { raw: 60, traded: 60, halted: 0 }, series,
  });
  const points = decisionPointsFrom(runResearch({ quote: quote(), articles: [], valuation: val }).stages);
  const vp = points.find((p) => p.from === "valuation");
  assert.ok(vp, "有估值序列就该出分位裁决点");
  assert.match(vp!.threshold, /穿越/);
  assert.match(vp!.effect, /不等于便宜/, "分位裁决点必须带反证提醒");
});

test("有缺口时出一条「补数据」裁决点，且只出一条", () => {
  const points = decisionPointsFrom(runResearch({ quote: quote(), articles: [] }).stages);
  const gaps = points.filter((p) => p.object.includes("数据缺口"));
  assert.equal(gaps.length, 1, "列多了像免责声明");
  assert.match(gaps[0]!.effect, /可能整体改变/);
});

test("裁决点里不出现动作词", () => {
  const points = decisionPointsFrom(runResearch({ quote: quote(), articles: [] }).stages);
  for (const p of points) {
    const all = `${p.object}${p.threshold}${p.effect}`;
    assert.ok(!/(建议|应该买入|可以买入|加仓|减仓|清仓|目标价|止损在)/.test(all), `出现动作词：${all}`);
  }
});

test("口径段点名不许编赤轨没有的数据", () => {
  assert.match(CATALYST_SOP, /一致预期/);
  assert.match(CATALYST_SOP, /强结论必须先找反证/);
  assert.match(CATALYST_SOP, /不写该做什么/);
});
