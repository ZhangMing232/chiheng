/**
 * 这个文件是干什么的：
 * 钉住 agent-loop 诊断层的纯函数口径——账本摘要怎么行话化、诊断 prompt 里
 * 必须出现哪些事实、模型输出的 JSON 怎么抠出来怎么校验。这些都是「AI 大脑
 * 看见什么、说什么」的边界，钉死了 AI 才不会被喂编造的上下文或吞掉乱返回。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiagnosisPrompt,
  evidenceOf,
  extractJson,
  parseDiagnosis,
  summarizeChallengerSamples,
  summarizeMarketRow,
  summarizeQueue,
  summarizeRunRow,
  verifyDiagnosisNumbers,
  type LedgerSnapshot,
} from "@/lib/market/agent-loop";

const SNAP: LedgerSnapshot = {
  at: "2026-10-21T00:00:00Z",
  factorLines: ["- 测试因子（test_f）：t=2.50，6 关过 6/6"],
  factorMeta: "共 5 批判决；最近一批 2026-10-21，8 个因子，样本 247 个交易日",
  queueLines: ["- 队列共 46 条，活着 8（待验 3 / 测过 5 / 已过 6 关 0），坟墓 38"],
  necropsy: ["- 死因统计："],
  championLines: ["- 测试策略：代码默认参数（持有10天）"],
  chalLines: ["- 挑战者A（c_a）：挑战「测试策略」，状态 running，2026-10-21 开跑，AI 提名"],
  chalSampleLines: ["- 挑战者A（c_a）：纸面样本 5 笔（已平仓 2 / 持仓 3），最近建仓 2026-10-21，Welch 判决要 30 笔已平仓，还差 28 笔"],
  gateLines: ["- 测试策略：假释观察中，正常"],
  selfHistory: ["- 因子层进化 10 轮，策略层 10 轮"],
  marketEvidence: ["920296 N文峰 217.03% · 成交 7.6 亿"],
};

test("summarizeRunRow：t 值、过关数、DSR 口径都对", () => {
  const base = {
    at: "t", factor: "f", name: "名", direction: 1 as const, n: 3, buckets: 5, offset: 0,
    universe: 300, nDays: 247, meanSpread: 0.004, t: 2.5, topBlockedRatio: 0.2,
    bucketMeans: [1, 2, 3, 4, 5], resampleSpread: 0.004, resampleT: 2.4, halfSpread: [0.004, 0.004],
    halfT: [2.4, 2.4], gateDetails: {}, gates: { g1: true, g2: true, g3: true, g4: true, g5: true, g6: true }, nTested: 8,
  };
  const line = summarizeRunRow(base);
  assert.match(line, /t=2\.50/);
  assert.match(line, /6 关过 6\/6/);
  // 没有 DSR 字段不提运气线
  assert.ok(!line.includes("DSR"));
  const withDsr = summarizeRunRow({ ...base, dsr: { value: 0.31, expectedMax: 0.28, survives: true, nTrials: 8 } });
  assert.match(withDsr, /DSR 31%（过运气线）/);
  const dead = summarizeRunRow({ ...base, dsr: { value: 0.2, expectedMax: 0.28, survives: false, nTrials: 8 } });
  assert.match(dead, /DSR 20%（运气线 28% 未过）/);
});

test("summarizeQueue：活/坟墓口径", () => {
  const entries = [
    { status: "pending" }, { status: "tested" }, { status: "passed" },
    { status: "tombstone" }, { status: "tombstone" }, { status: "monitoring" },
  ];
  const lines = summarizeQueue(entries);
  assert.match(lines[0], /队列共 6 条，活着 4/);
  assert.match(lines[0], /坟墓 2/);
});

test("buildDiagnosisPrompt：账本各块都在，且声明只诊断不行动", () => {
  const p = buildDiagnosisPrompt(SNAP);
  for (const fact of [
    "测试因子（test_f）", "队列共 46 条", "死因统计", "挑战者A",
    "纸面样本 5 笔", "Welch 判决要 30 笔已平仓",
    "规则变更请求", "ruleChangeRequests", "你的任务是诊断，不是行动",
    "N文峰", "当日市场证据",
  ]) {
    assert.ok(p.includes(fact), `prompt 缺：${fact}`);
  }
});

test("市场证据：行摘要 + JSON 解析 + 坏输入降级", () => {
  assert.equal(summarizeMarketRow({ code: "920296", name: "N文峰", change_pct: 21703, amount: 759246929.88 }), "920296 N文峰 217.03% · 成交 7.6 亿");
  // 真工具返回形状（ok + data.rows）
  const raw = JSON.stringify({ ok: true, data: { rows: [
    { code: "920296", name: "N文峰", change_pct: 21703, amount: 759246929.88 },
    { code: "300750", name: "宁德时代", change_pct: 285, amount: 8.9e9 },
  ] } });
  const lines = evidenceOf(raw);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /宁德时代 2.85%/);
  assert.equal(evidenceOf('{"ok": false}').length, 0);
  assert.equal(evidenceOf("not json").length, 0);
  assert.equal(evidenceOf('{"ok":true,"data":{}}').length, 0);
  // 截断到 maxRows
  const many = JSON.stringify({ ok: true, data: { rows: Array.from({ length: 20 }, (_, i) => ({ code: String(i), name: "x", change_pct: 1, amount: 1 })) } });
  assert.equal(evidenceOf(many, 10).length, 10);
});

test("extractJson：前后有杂音也能抠出来；没有 { } 返回 null", () => {
  assert.equal(extractJson('前言 {"a":1} 后记'), '{"a":1}');
  assert.equal(extractJson("没有 json"), null);
  assert.equal(extractJson("}{"), null);
});

test("parseDiagnosis：合法 JSON 收齐五字段；字段缺失补默认；非对象返回 null", () => {
  const good = parseDiagnosis('xx {"summary":"s","factorLayer":"f","strategyLayer":"t","suggestions":["a"],"ruleChangeRequests":[]} yy');
  assert.deepEqual(good, { summary: "s", factorLayer: "f", strategyLayer: "t", suggestions: ["a"], ruleChangeRequests: [] });
  // 缺字段 → 补默认而不是抛错
  const partial = parseDiagnosis('{"summary":"只有总评"}');
  assert.deepEqual(partial, { summary: "只有总评", factorLayer: "", strategyLayer: "", suggestions: [], ruleChangeRequests: [] });
  // suggestions 里混了非字符串被过滤
  const mixed = parseDiagnosis('{"summary":"s","suggestions":["ok", 42, null]}');
  assert.deepEqual(mixed?.suggestions, ["ok"]);
  assert.equal(parseDiagnosis("完全不是 json"), null);
  assert.equal(parseDiagnosis('{"summary":123}')?.summary, "");
});

test("summarizeChallengerSamples：已平仓/持仓/最近建仓/距 Welch 差几笔", () => {
  const chals = [
    { id: "c_a", name: "挑战者A" },
    { id: "c_b", name: "挑战者B" },
  ];
  const trades = [
    { variant: "c_a", exit: 10.5, date: "2026-10-01" },
    { variant: "c_a", exit: null, date: "2026-10-21" },
    { variant: "c_a", exit: 11.0, date: "2026-10-10" },
    { variant: "c_b", exit: null, date: "2026-10-20" },
  ];
  const lines = summarizeChallengerSamples(chals, trades);
  assert.match(lines[0], /挑战者A（c_a）：纸面样本 3 笔（已平仓 2 \/ 持仓 1）/);
  assert.match(lines[0], /最近建仓 2026-10-21/);
  assert.match(lines[0], /还差 28 笔/);
  assert.match(lines[1], /挑战者B（c_b）：纸面样本 1 笔（已平仓 0 \/ 持仓 1）/);
  assert.match(lines[1], /还差 30 笔/);
  // 账本里一行都没有的挑战者如实说看不到，不编数
  const none = summarizeChallengerSamples([{ id: "c_c", name: "挑战者C" }], trades);
  assert.match(none[0], /还看不到它的纸面样本/);
  // 攒够 30 笔已平仓 → 已够格
  const full = summarizeChallengerSamples(
    [{ id: "c_d", name: "挑战者D" }],
    Array.from({ length: 30 }, (_, i) => ({ variant: "c_d", exit: 10 + i, date: "2026-10-21" })),
  );
  assert.match(full[0], /已够格/);
});

test("verifyDiagnosisNumbers：快照里有的数字放行，没出处的数字列出来（标注不拦截）", () => {
  const ok = {
    summary: "测试因子 t=2.50 已过 6 关",
    factorLayer: "",
    strategyLayer: "",
    suggestions: [],
    ruleChangeRequests: [],
  };
  assert.deepEqual(verifyDiagnosisNumbers(ok, SNAP), { ungrounded: [] });

  const bad = {
    summary: "神秘数字 999.9 说明一切",
    factorLayer: "",
    strategyLayer: "",
    suggestions: [],
    ruleChangeRequests: [],
  };
  const check = verifyDiagnosisNumbers(bad, SNAP);
  assert.ok(check.ungrounded.includes("999.9"));
  // 汇总五字段全部参与核验：suggestions / ruleChangeRequests 里的数也查
  const mixed = {
    ...ok,
    suggestions: ["提议新因子，参考 247 个交易日的口径"],
    ruleChangeRequests: ["6 关阈值太严，建议看看 888 这个数"],
  };
  const mixedCheck = verifyDiagnosisNumbers(mixed, SNAP);
  assert.ok(!mixedCheck.ungrounded.includes("247"));
  assert.ok(mixedCheck.ungrounded.includes("888"));
});
