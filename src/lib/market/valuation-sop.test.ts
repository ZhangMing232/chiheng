/**
 * 这个文件是干什么的：
 * 钉住估值判读——尤其**那些最容易被读反的组合**。
 *
 * 「PE 低 + PB 高」是周期底部特征，单独读会变成「便宜」；「PE 高 + PB 低」
 * 可能是盈利改善也可能是资产被重估，两者结论相反。这些必须由代码判，不能靠 AI。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VALUATION_SOP, valuationJudgement } from "@/lib/market/valuation-sop";

test("两边都低分位：判「偏低」但必须附周期顶反证", () => {
  const j = valuationJudgement(8, 12)!;
  assert.match(j.verdict, /低分位/);
  assert.match(j.caution, /周期/, "低分位必须带反证条件");
});

test("两边都高分位：判「偏高」但必须附周期底反证", () => {
  const j = valuationJudgement(92, 85)!;
  assert.match(j.verdict, /高分位/);
  assert.match(j.caution, /周期/);
});

test("PE 低 PB 高：这是周期底部特征，不许读成便宜", () => {
  const j = valuationJudgement(8, 90)!;
  assert.match(j.caution, /周期底部/);
  assert.ok(!/便宜/.test(j.verdict), "判读里不许出现「便宜」这种结论词");
});

test("PE 高 PB 低：要分清盈利改善还是资产重估", () => {
  const j = valuationJudgement(92, 8)!;
  assert.match(j.caution, /盈利改善|重估/);
});

test("只有一个口径：明说缺哪个，不拿相近口径顶替", () => {
  const j = valuationJudgement(8, null)!;
  assert.match(j.verdict, /只有 PE 分位可用/);
  assert.match(j.verdict, /判读不完整|另一个口径没数据/);
});

test("两边都没有：返回 null，调用方要写缺口", () => {
  assert.equal(valuationJudgement(null, null), null);
  assert.equal(valuationJudgement(null, null, ), null);
});

test("中段不给中庸判读以外的结论", () => {
  const j = valuationJudgement(50, 55)!;
  assert.match(j.verdict, /中段/);
  assert.equal(j.caution, "");
});

test("判读里绝不出现动作词", () => {
  for (const [pe, pb] of [[5, 5], [95, 95], [5, 95], [95, 5], [50, 50]] as const) {
    const j = valuationJudgement(pe, pb)!;
    for (const text of [j.verdict, j.caution]) {
      assert.ok(!/(买入|卖出|加仓|减仓|清仓|建仓|目标价|止损)/.test(text), `出现动作词：${text}`);
    }
  }
});

test("口径段写死「不许编赤轨没有的数据」", () => {
  assert.match(VALUATION_SOP, /一致预期/, "要明确点名不许拿一致预期填空");
  assert.match(VALUATION_SOP, /不许输出价格锚/);
  assert.match(VALUATION_SOP, /不给买卖建议/);
});
