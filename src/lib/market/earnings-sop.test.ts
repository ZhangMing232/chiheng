/**
 * 这个文件是干什么的：
 * 钉住财报转向判断——**只描述发生了什么、不推测原因、数据不够就写缺口**。
 *
 * 「不推测原因」这条最重要：毛利率下滑是降价还是成本涨，比率里看不出来。
 * 让 AI 补一个听起来合理的原因，就是编。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EARNINGS_SOP, readEarnings, sortByAnn, type EarningsPoint } from "@/lib/market/earnings-sop";

function p(over: Partial<EarningsPoint> = {}): EarningsPoint {
  return { ann: "20260120", period: "20251231", roe: 10, dtYoy: 20, gm: 40, debt: null, ...over };
}

/** 造 n 期，字段按给定数组走。 */
function series(dtYoy: number[], gm: number[], roe: number[]): EarningsPoint[] {
  return dtYoy.map((v, i) => p({ ann: `2026${String(i + 1).padStart(2, "0")}01`, period: `2026${String(i + 1).padStart(2, "0")}30`, dtYoy: v, gm: gm[i]!, roe: roe[i]! }));
}

test("按公告日期排序，不按报告期（补披露会修正前面的）", () => {
  const rows = [p({ ann: "20260408", dtYoy: 5 }), p({ ann: "20260120", dtYoy: 20 })];
  const sorted = sortByAnn(rows);
  assert.deepEqual(sorted.map((r) => r.ann), ["20260120", "20260408"]);
});

test("同比连续两期为正 → 判「连续为正」并要求警惕低基数", () => {
  const r = readEarnings(series([10, 15], [40, 40], [10, 10]));
  const t = r.turns.find((x) => x.label === "净利润同比")!;
  assert.match(t.verdict, /都为正/);
  assert.match(t.caution, /低基数/, "必须提醒可能来自低基数");
});

test("同比由正转负 → 这是最硬的转向信号", () => {
  const r = readEarnings(series([12, -5], [40, 40], [10, 10]));
  const t = r.turns.find((x) => x.label === "净利润同比转负")!;
  assert.match(t.verdict, /由正转负/);
  assert.match(t.caution, /累计口径/);
});

test("毛利率连续两期下滑 → 判下滑但不推测原因", () => {
  const r = readEarnings(series([10, 10], [42, 38], [10, 10]));
  const t = r.turns.find((x) => x.label === "毛利率")!;
  assert.match(t.verdict, /连续下滑/);
  assert.match(t.caution, /看不出是降价还是成本涨/, "不许推测原因");
});

test("ROE 连续下滑 → 提醒分不清利润率/周转/杠杆", () => {
  const r = readEarnings(series([10, 10], [40, 40], [14, 11]));
  const t = r.turns.find((x) => x.label === "ROE")!;
  assert.match(t.verdict, /连续下滑/);
  assert.match(t.caution, /杜邦/, "要说明缺三表拆不开");
});

test("只有一期 → 不判断，写缺口", () => {
  const r = readEarnings(series([10], [40], [10]));
  assert.equal(r.turns.length, 0, "一期看不出趋势");
  assert.ok(r.gaps.some((g) => g.includes("只有一个报告期")));
});

test("一条数据都没有 → 写缺口并说明怎么补", () => {
  const r = readEarnings([]);
  assert.match(r.gaps[0]!, /fetch-fundamentals/);
  assert.equal(r.latest, null);
});

test("debt 恒为 null 这件事要说出口", () => {
  const r = readEarnings(series([10, 10], [40, 40], [10, 10]));
  assert.ok(r.gaps.some((g) => g.includes("资产负债率")), "偿债能力那段是空的，必须写明");
});

test("转向判断里不出现动作词", () => {
  const r = readEarnings(series([12, -5], [42, 38], [14, 11]));
  for (const t of r.turns) {
    for (const text of [t.verdict, t.caution]) {
      assert.ok(!/(建议|应该买入|可以买入|加仓|减仓|清仓|目标价|止损在)/.test(text), `出现动作词：${text}`);
    }
  }
});

test("口径段点名不许提单季/TTM 这些赤轨算不出的", () => {
  assert.match(EARNINGS_SOP, /不许提单季/);
  assert.match(EARNINGS_SOP, /不推测原因/);
  assert.match(EARNINGS_SOP, /公告日期/);
});
