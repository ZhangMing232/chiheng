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

test("attributeTradeLoss：日线跳空穿止损（成交明显低于止损价）", () => {
  const a = attributeTradeLoss({ ...base, exit: 8.0, stop: 9.2, exitReason: "stop", exitKind: "daily" });
  assert.ok(a);
  assert.equal(a!.cause, "gap_down");
  assert.match(a!.causal, /跳空/);
});

test("attributeTradeLoss：盘中下穿止损算滑点，不能报成跳空", () => {
  const a = attributeTradeLoss({ ...base, exit: 8.0, stop: 9.2, exitReason: "stop", exitKind: "intraday" });
  assert.ok(a);
  assert.equal(a!.cause, "stop_slipped");
  // 关键区别：滑点是可以防的，跳空防不住。两者不能混成一句「跳空」。
  assert.match(a!.causal, /滑点/);
  assert.match(a!.causal, /可以防/);
  const gap = attributeTradeLoss({ ...base, exit: 8.0, stop: 9.2, exitReason: "stop", exitKind: "daily" })!;
  assert.match(gap.causal, /防不住/);
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

test("来源分档：缺 exitReasonSource = 原始记录，有就照抄，判不了 = unknown", () => {
  const original = attributeTradeLoss({ ...base, exit: 9.2, stop: 9.2, exitReason: "stop" })!;
  assert.equal(original.source, "original");
  const legacy = attributeTradeLoss({
    ...base,
    exit: 9.2,
    stop: 9.2,
    exitReason: "stop",
    exitReasonSource: "legacy_planned",
  })!;
  assert.equal(legacy.source, "legacy_planned");
  const bogus = attributeTradeLoss({ ...base, exit: 9.2, stop: 9.2, exitReason: "stop", exitReasonSource: "瞎写的" })!;
  assert.equal(bogus.source, "unknown");
  const none = attributeTradeLoss({ ...base, exit: 9.5 })!;
  assert.equal(none.source, "unknown");
});

test("lossAttribLines：来源分档要写进 prompt，旧口径/未定型的价格提示不能省", () => {
  const attribs = [
    attributeTradeLoss({ ...base, exit: 9.2, stop: 9.2, exitReason: "stop" })!,
    attributeTradeLoss({
      id: "sh600003",
      entry: 10,
      exit: 9.0,
      stop: 9.0,
      exitReason: "stop",
      exitReasonSource: "legacy_planned",
    })!,
    attributeTradeLoss({
      id: "sh600004",
      entry: 10,
      exit: 9.5,
      exitReason: "time",
      exitReasonSource: "recorded_price_partial",
    })!,
  ];
  const sum = summarizeTradeLosses(attribs);
  assert.equal(sum.bySource.length, 3);
  assert.equal(sum.bySource.find((s) => s.source === "legacy_planned")!.count, 1);
  const lines = lossAttribLines(sum);
  const joined = lines.join("\n");
  assert.match(joined, /证据来源/);
  assert.match(joined, /旧口径反推 1 笔/);
  // 这两档的幅度不可信，必须在 prompt 里点出来，否则 AI 会拿假幅度调参数
  assert.match(joined, /只能取「原因」，不能取「幅度」/);
  assert.match(joined, /原因可信，幅度别当真/);
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

test("byStyle：按策略拆开，策略名进中文、share 归一", () => {
  const attribs = [
    attributeTradeLoss({ id: "sz0001", style: "breakout", entry: 10, exit: 9.2, stop: 9.2, exitReason: "stop" })!,
    attributeTradeLoss({ id: "sz0002", style: "breakout", entry: 10, exit: 9.0, exitReason: "time" })!,
    attributeTradeLoss({ id: "sh600001", style: "rebound", entry: 10, exit: 9.5, exitReason: "time" })!,
  ];
  const sum = summarizeTradeLosses(attribs);
  const breakout = sum.byStyle.find((s) => s.style === "breakout");
  assert.ok(breakout);
  assert.equal(breakout.count, 2);
  assert.equal(breakout.share, 0.667); // 实现保留 3 位小数
  assert.equal(breakout.byCause[0]!.cause, "stop_planned");
  const lines = lossAttribLines(sum);
  const styleLine = lines.find((l) => l.includes("放量突破"));
  assert.ok(styleLine, "按策略段必须用中文名");
  assert.match(styleLine!, /止损按计划触发×1/);
});

test("byStyle：没有 style 字段的旧账归到 unknown，不炸", () => {
  const attribs = [attributeTradeLoss({ id: "sz0009", entry: 10, exit: 9.0, exitReason: "time" })!];
  const sum = summarizeTradeLosses(attribs);
  assert.equal(sum.byStyle.length, 1);
  assert.equal(sum.byStyle[0]!.style, "unknown");
});
