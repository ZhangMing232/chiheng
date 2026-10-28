/**
 * 失败归因的测试：逐笔亏损按退出原因分 cause + 因果叙述；挑战者判决归因。
 * 钉住「老账没记退出原因 → 不猜、标 unknown_legacy」这条纪律。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  attributeChallengerVerdict,
  attributeTradeLoss,
  CAUSE_LABEL,
  challengerVerdictLines,
  lossAttribLines,
  summarizeTradeLosses,
  verdictCauseOf,
} from "@/lib/market/loss-attrib";

const base = { id: "sh600000", name: "浦发银行", entry: 10 };

test("attributeTradeLoss：止损按计划触发（成交≈止损价）", () => {
  const a = attributeTradeLoss({ ...base, exit: 9.2, stop: 9.2, exitReason: "stop" });
  assert.ok(a);
  assert.equal(a!.cause, "stop_planned");
  assert.ok(a!.retPct < 0);
  assert.match(a!.causal, /止损/);
});

test("attributeTradeLoss：跳空穿止损（成交明显低于止损价）", () => {
  const a = attributeTradeLoss({ ...base, exit: 8.0, stop: 9.2, exitReason: "stop" });
  assert.ok(a);
  assert.equal(a!.cause, "gap_down");
  assert.match(a!.causal, /跳空/);
});

test("attributeTradeLoss：持有到期没走出来", () => {
  const a = attributeTradeLoss({ ...base, exit: 9.5, exitReason: "time" });
  assert.ok(a);
  assert.equal(a!.cause, "time_exit");
});

test("attributeTradeLoss：老账没记退出原因 → unknown_legacy，不猜", () => {
  const a = attributeTradeLoss({ ...base, exit: 9.5 });
  assert.ok(a);
  assert.equal(a!.cause, "unknown_legacy");
  assert.match(a!.causal, /无法判定/);
});

test("attributeTradeLoss：盈利/未平仓不算亏损（返回 null）", () => {
  assert.equal(attributeTradeLoss({ ...base, exit: 11, exitReason: "target" }), null);
  assert.equal(attributeTradeLoss({ ...base, exit: null }), null);
});

test("attributeTradeLoss：给了大盘跌数就标 systematic 并在因果里补一句", () => {
  const a = attributeTradeLoss({ ...base, exit: 9.5, exitReason: "time" }, { marketRetPct: -1.8 });
  assert.ok(a);
  assert.equal(a!.systematic, true);
  assert.match(a!.causal, /系统性回撤/);
  assert.equal(a!.marketRetPct, -1.8);
});

test("summarizeTradeLosses + lossAttribLines：按 cause 聚合，空则空数组", () => {
  const attribs = [
    attributeTradeLoss({ ...base, exit: 9.2, stop: 9.2, exitReason: "stop" })!,
    attributeTradeLoss({ id: "sh600001", entry: 10, exit: 9.0, stop: 9.0, exitReason: "stop" })!,
    attributeTradeLoss({ id: "sh600002", entry: 10, exit: 9.5, exitReason: "time" })!,
  ];
  const sum = summarizeTradeLosses(attribs);
  assert.equal(sum.losses, 3);
  const stop = sum.byCause.find((c) => c.cause === "stop_planned");
  assert.ok(stop);
  assert.equal(stop!.count, 2);
  const lines = lossAttribLines(sum);
  assert.ok(lines.length > 0);
  assert.match(lines[0], /已平仓亏损 3 笔/);
  // 没亏损 → 空数组，不出假条目
  assert.deepEqual(lossAttribLines(summarizeTradeLosses([])), []);
  assert.equal(CAUSE_LABEL.stop_planned, "止损按计划触发");
});

test("verdictCauseOf：action + reason 文案映射", () => {
  assert.equal(verdictCauseOf("promote", ""), "promote_superior");
  assert.equal(verdictCauseOf("inconclusive", ""), "inconclusive_max_trades");
  assert.equal(verdictCauseOf("reject", "提前否决：跑输冠军"), "reject_early_gap");
  assert.equal(verdictCauseOf("reject", "挑战者自身质量不过关"), "reject_own_quality");
  assert.equal(verdictCauseOf("reject", "别的原因"), "reject_other");
});

test("attributeChallengerVerdict + challengerVerdictLines：结构化因果档案", () => {
  const v = attributeChallengerVerdict({
    chal: { id: "c1", style: "breakout", name: "挑战者一", stopPct: 8 },
    action: "reject",
    reason: "提前否决：建仓满 15 个交易日后纸面均值 -3% 跑输冠军 0%",
    champRets: [0.01, 0.02, 0.0],
    chalRets: [-0.02, -0.03],
    day: "2026-10-28",
  });
  assert.equal(v.cause, "reject_early_gap");
  assert.equal(v.chalN, 2);
  assert.equal(v.champN, 3);
  assert.equal(v.chalMeanPct, -2.5);
  assert.match(v.causal, /时间盒/);
  const lines = challengerVerdictLines([v]);
  assert.match(lines[0], /判决档案 1 条/);
});
