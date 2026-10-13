/**
 * 这个文件是干什么的：
 * 钉住产业链 SOP（industry 阶段）的三条纪律。
 *
 * 1. **没数据就写缺口**：分类没抓、月度没抓、月份不够——三种都得说清，
 *    不许拿空 evidence 冒充「这个行业没有事发生」
 * 2. **不给买卖暗示**：finding 全过红线（screenAdvice）
 * 3. **不编上下游**：这个阶段只说行业自身，输出里不该出现产业链链条的断言
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { industryStage, type BoardMonthly } from "@/lib/market/industry-chain";
import { buildIndustryIndex, type IndustryIndex } from "@/lib/market/industry";
import { screenAdvice } from "@/lib/market/red-line";
import { monthlyFromBars, type BoardDaily } from "@/lib/market/industry-monthly";

const TODAY = "2026-10-13";

function index(): IndustryIndex {
  return buildIndustryIndex(
    [
      { code: "BK1340", name: "印制电路板", members: ["sh688655", "sz301041"] },
      { code: "BK0459", name: "元件", members: ["sh688655", "sz301041", "sh600000"] },
    ],
    "2026-10-13",
  );
}

/** 造 4 个月日线：每月 20 个交易日，最近三个月两涨一跌。 */
function daily(): BoardDaily[] {
  const bars: BoardDaily[] = [];
  let price = 100;
  for (const [mi, month] of ["2026-05", "2026-06", "2026-07", "2026-08"].entries()) {
    for (let d = 1; d <= 20; d += 1) {
      price += mi === 2 ? -0.1 : 0.5;
      bars.push({ date: `${month}-${String(d).padStart(2, "0")}`, open: price, close: price, high: price, low: price, amount: 1e8, turnover: 2 });
    }
  }
  return bars;
}

function monthly(): BoardMonthly {
  const flow = ["2026-06-05", "2026-07-05", "2026-08-05"].map((date) => ({ date, mainNet: 1e8 }));
  const { months } = monthlyFromBars(daily(), flow, TODAY);
  return { code: "BK1340", name: "印制电路板", months };
}

test("分类没抓过就写缺口，不给行业归属", () => {
  const stage = industryStage({ id: "sh688655", name: "迅捷兴", index: null, monthly: null });
  assert.ok(stage.gaps.some((g) => g.includes("行业分类没抓过")));
  assert.equal(stage.evidence.length, 0);
});

test("票不在分类表里也要说，不能静默跳过", () => {
  const stage = industryStage({ id: "sz999999", name: "不存在的票", index: index(), monthly: null });
  assert.ok(stage.gaps.some((g) => g.includes("不在行业分类表里")));
});

test("有分类有月度：给出行业、月度证据和方向读数", () => {
  const stage = industryStage({ id: "sh688655", name: "迅捷兴", index: index(), monthly: monthly() });
  assert.equal(stage.evidence[0]?.value, "印制电路板", "取最细那层，不是更粗的「元件」");
  assert.ok(stage.evidence.some((e) => e.label.includes("月度涨跌")));
  assert.ok(stage.evidence.some((e) => e.label.includes("主力净流入")));
  const reading = stage.findings.find((f) => f.text.includes("温度计"));
  assert.ok(reading, "要给方向读数");
  assert.match(reading!.text, /升温/);
});

test("月度没抓过：行业照给，方向说缺数据", () => {
  const stage = industryStage({ id: "sh688655", name: "迅捷兴", index: index(), monthly: null });
  assert.equal(stage.evidence[0]?.value, "印制电路板");
  assert.ok(stage.gaps.some((g) => g.includes("月度数据没抓过")));
  assert.equal(stage.findings.some((f) => f.text.includes("温度计")), false, "没数据不给方向");
});

test("月份不够（全是 partial）时说读不出方向，不硬给", () => {
  // 只给当月开头几天：交易日不够 15 天，且当月还没走完 → 双重 partial
  const bars = [
    { date: "2026-10-09", open: 10, close: 10, high: 10, low: 10, amount: 1e8, turnover: 2 },
    { date: "2026-10-10", open: 11, close: 11, high: 11, low: 11, amount: 1e8, turnover: 2 },
  ];
  const { months } = monthlyFromBars(bars, [], TODAY);
  const stage = industryStage({
    id: "sh688655",
    name: "迅捷兴",
    index: index(),
    monthly: { code: "BK1340", name: "印制电路板", months },
  });
  assert.ok(stage.gaps.some((g) => g.includes("没有足够的完整月份")));
  assert.equal(stage.findings.some((f) => f.text.includes("温度计")), false);
});

test("多归属剪不掉时如实说明归属含糊", () => {
  const idx = buildIndustryIndex(
    [
      { code: "BK1", name: "元件", members: ["sh600000", "sh600001"] },
      { code: "BK2", name: "白酒Ⅱ", members: ["sh600000", "sh600002"] },
    ],
    "2026-10-13",
  );
  const stage = industryStage({ id: "sh600000", name: "浦发银行", index: idx, monthly: null });
  assert.ok(stage.evidence.some((e) => e.label === "其他归属"));
  assert.ok(stage.gaps.some((g) => g.includes("归属本身是含糊的")));
});

test("所有 finding 都过红线：不给买卖暗示，也不提产业链链条", () => {
  const stage = industryStage({ id: "sh688655", name: "迅捷兴", index: index(), monthly: monthly() });
  assert.ok(stage.findings.length > 0);
  for (const finding of stage.findings) {
    assert.equal(screenAdvice(finding.text).ok, true, `这句被红线拦了：${finding.text}`);
    assert.doesNotMatch(finding.text, /上游|下游|产业链上下游/, "不编上下游关系");
  }
});
