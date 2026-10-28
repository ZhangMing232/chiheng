/**
 * 这个文件是干什么的：
 * 钉住策略层 AI 管理的两块纯逻辑——挑战者提案校验、prompt 组装。
 *
 * 为什么值得钉（这一层离真钱近，校验要比因子层更死）：
 * 1. 旋钮越界（holdDays=2 或 stopPct=50）必须拒——范围就是给 AI 上的笼头。
 * 2. 三个参数全缺 = 冠军的复制品，没意义，必须拒。
 * 3. 和同策略在跑挑战者参数雷同必须拒；每策略在跑超 2 个必须拒——不然 AI
 *    一口气提名二十个，纸面名额稀释成噪声。
 * 4. 选股条件（style 以外的任何东西）AI 提不出来——schema 里根本没有那个字段。
 * 5. 一个被拒 continue 不中断整批（和 factor 层同款坑，这里再钉一次）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOBS,
  MAX_RUNNING_PER_STYLE,
  paramsKey,
  parseAIChallengerProposals,
  buildStrategyPrompt,
  type ChallengerProposal,
} from "@/lib/market/strategy-ai";
import type { Challenger } from "@/lib/market/challenger";

function chal(partial: Partial<Challenger>): Challenger {
  return {
    id: "c_existing",
    style: "breakout",
    name: "现有挑战者",
    holdDays: 12,
    status: "running",
    since: "2026-10-01",
    ...partial,
  };
}

function proposal(partial: Partial<ChallengerProposal>): ChallengerProposal {
  return {
    id: "q_hold8",
    style: "breakout",
    name: "突破·拿8天",
    rationale: "冠军拿10天止损偏宽，缩量环境下短持可能落袋更稳",
    holdDays: 8,
    ...partial,
  };
}

test("合格的提案被接受，```json 围栏也能解", () => {
  const raw = '```json\n[{"id":"q_hold8","style":"breakout","name":"突破·拿8天","rationale":"冠军拿10天止损偏宽，缩量环境下短持可能落袋更稳","holdDays":8}]\n```';
  const { accepted, rejected } = parseAIChallengerProposals(raw, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].holdDays, 8);
  assert.equal(rejected.length, 0);
});

test("参数越界、非整数、全缺，都拒且写明原因", () => {
  const raw = JSON.stringify([
    proposal({ id: "q_a", holdDays: (KNOBS.holdDays.min - 1) as number }),
    proposal({ id: "q_b", stopPct: 10.5 }),
    proposal({ id: "q_c", holdDays: undefined }),
    proposal({ id: "q_d", targetPct: (KNOBS.targetPct.max + 1) as number }),
  ]);
  const { accepted, rejected } = parseAIChallengerProposals(raw, []);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 4);
  assert.match(rejected[0].reason, /越界/);
  assert.match(rejected[1].reason, /整数/);
  assert.match(rejected[2].reason, /复制品/);
  assert.match(rejected[3].reason, /越界/);
});

test("style 不在词表、id 撞名、理由太短，都拒", () => {
  const raw = JSON.stringify([
    proposal({ id: "q_a", style: "magic" }),
    proposal({ id: "c_existing" }),
    proposal({ id: "q_c", rationale: "短" }),
  ]);
  const { accepted, rejected } = parseAIChallengerProposals(raw, [chal({})]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 3);
  assert.match(rejected[0].reason, /词表/);
  assert.match(rejected[1].reason, /已存在/);
  assert.match(rejected[2].reason, /太短/);
});

test("和同策略在跑挑战者参数雷同被拒，别的策略可以同名参数", () => {
  const existing = [chal({ id: "c1", style: "breakout", holdDays: 8 })];
  const raw = JSON.stringify([
    proposal({ id: "q_a", style: "breakout", holdDays: 8 }), // 雷同
    proposal({ id: "q_b", style: "rebound", holdDays: 8 }), // 别策略，OK
  ]);
  const { accepted, rejected } = parseAIChallengerProposals(raw, existing);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].style, "rebound");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /雷同/);
});

test(`每策略在跑超过 ${MAX_RUNNING_PER_STYLE} 个挑战者时拒新提案`, () => {
  const existing = [
    chal({ id: "c1", holdDays: 8 }),
    chal({ id: "c2", holdDays: 15 }),
  ];
  const { accepted, rejected } = parseAIChallengerProposals(JSON.stringify([proposal({ id: "q_a" })]), existing);
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /在跑挑战者/);
});

test("已结束（promoted/rejected）的挑战者不占在跑名额", () => {
  const existing = [
    chal({ id: "c1", holdDays: 8 }),
    chal({ id: "c2", holdDays: 15, status: "rejected" }),
  ];
  const { accepted } = parseAIChallengerProposals(JSON.stringify([proposal({ id: "q_a", holdDays: 9 })]), existing);
  assert.equal(accepted.length, 1);
});

test("一个被拒不中断整批", () => {
  const raw = JSON.stringify([
    proposal({ id: "bad!" }),
    proposal({ id: "q_ok" }),
  ]);
  const { accepted, rejected } = parseAIChallengerProposals(raw, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "q_ok");
  assert.equal(rejected.length, 1);
});

test("返回里没有 JSON 数组：整批拒绝，不抛", () => {
  const { accepted, rejected } = parseAIChallengerProposals("今天天气不错", []);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

test("paramsKey：缺省和显式值是不同指纹，全同才是雷同", () => {
  assert.notEqual(paramsKey({ holdDays: 8 }), paramsKey({}));
  assert.equal(paramsKey({ holdDays: 8, stopPct: 10 }), paramsKey({ stopPct: 10, holdDays: 8 }));
});

test("buildStrategyPrompt：判决产物原样进 prompt，含旋钮范围和名额上限", () => {
  const prompt = buildStrategyPrompt({
    challengers: [chal({}), chal({ id: "c_done", status: "promoted", holdDays: 20 })],
    gates: { breakout: { state: "disabled", since: "2026-10-01", cooldownDays: 10, strikes: 1, reason: "最近 20 笔 t=-2.3" } },
    logTail: ["breakout: c1 → champion（策略闸停用，参数自动回滚）"],
    passedFactors: [{ id: "q_lcap", name: "大市值溢价", direction: 1, expr: "log(floatCap)" }],
    champions: [
      { style: "breakout", source: "代码默认参数", params: "持有8天；止损/目标 = 策略内置公式" },
      { style: "rebound", source: "已转正挑战者「耐心持有」（c_slow）", params: "持有12天 / 止损8% / 目标25%" },
    ],
  });
  assert.match(prompt, /突破·拿12天|现有挑战者/);
  assert.match(prompt, /停用中（第 1 次/);
  assert.match(prompt, /参数自动回滚/);
  assert.match(prompt, /大市值溢价/);
  assert.match(prompt, /holdDays（3~30/);
  assert.match(prompt, /最多 2 个在跑挑战者/);
  assert.match(prompt, /只输出 JSON 数组/);
  // 冠军参数进 prompt（冷启动提案的基准），含冷启动不空转铁律
  assert.match(prompt, /冠军当前参数/);
  assert.match(prompt, /已转正挑战者「耐心持有」/);
  assert.match(prompt, /持有8天；止损\/目标 = 策略内置公式/);
  assert.match(prompt, /冷启动不许空转/);
});

test("buildStrategyPrompt：给了自我历史就追加反馈段，没给不追加", () => {
  const base = {
    challengers: [],
    gates: {},
    logTail: [],
    passedFactors: [],
    champions: [],
  };
  const withHistory = buildStrategyPrompt({ ...base, selfHistory: ["- 10-08：你提名「快止盈」（c_a）——已淘汰（Welch 判决质量不过关）"] });
  assert.match(withHistory, /你自己之前几轮提名的下场/);
  assert.match(withHistory, /c_a.*已淘汰/);
  const bare = buildStrategyPrompt(base);
  assert.doesNotMatch(bare, /你自己之前几轮提名的下场/);
});

test("buildStrategyPrompt：给了当日市场快照就追加证据段，没给不追加", () => {
  const base = {
    challengers: [],
    gates: {},
    logTail: [],
    passedFactors: [],
    champions: [],
  };
  const withEvidence = buildStrategyPrompt({ ...base, marketEvidence: ["N文峰 600099.SH +5.21% 成交 8.3亿"] });
  assert.match(withEvidence, /当日市场证据/);
  assert.match(withEvidence, /N文峰/);
  assert.match(withEvidence, /不要当成历史规律/);
  const bare = buildStrategyPrompt(base);
  assert.doesNotMatch(bare, /当日市场证据/);
});

test("buildStrategyPrompt：给了诊断建议就追加 plan 层段，没给不追加", () => {
  const base = {
    challengers: [],
    gates: {},
    logTail: [],
    passedFactors: [],
    champions: [],
  };
  const withHints = buildStrategyPrompt({ ...base, diagnosisHints: ["- 给 breakout 提一个更紧止损的变体（诊断 2026-10-21）"] });
  assert.match(withHints, /AI 管家的诊断建议/);
  assert.match(withHints, /更紧止损/);
  const bare = buildStrategyPrompt(base);
  assert.doesNotMatch(bare, /AI 管家的诊断建议/);
});

test("buildStrategyPrompt：挑战者样本进度给了就进 prompt，没给不硬塞", () => {
  const base = {
    challengers: [chal({})],
    gates: {},
    logTail: [],
    passedFactors: [],
    champions: [{ style: "breakout", source: "代码默认参数", params: "持有8天" }],
  };
  const without = buildStrategyPrompt({ ...base });
  assert.ok(!without.includes("纸面样本进度"));
  const withLines = buildStrategyPrompt({
    ...base,
    chalSampleLines: ["- 挑战者A（c_a）：纸面样本 3 笔（已平仓 0 / 持仓 3），最近建仓 2026-10-21，Welch 判决要 30 笔已平仓，还差 30 笔"],
  });
  assert.match(withLines, /纸面样本进度/);
  assert.match(withLines, /挑战者A（c_a）：纸面样本 3 笔/);
  assert.match(withLines, /还差 30 笔/);
});

test("prompt：给了亏损归因就整段进 prompt，没给就不出空段", () => {
  const base = {
    challengers: [chal({})],
    gates: {},
    logTail: [],
    passedFactors: [],
    champions: [{ style: "breakout", source: "代码默认参数", params: "持有8天" }],
  };
  const without = buildStrategyPrompt(base);
  assert.ok(!without.includes("逐笔亏损归因"), "没喂归因时不该出现空段");
  const withLoss = buildStrategyPrompt({ ...base, lossAttribLines: ["已平仓亏损 2 笔，按亏损原因分：", "- 放量突破：2 笔（占 100%）——止损按计划触发×2（均 -1.5%）"] });
  assert.ok(withLoss.includes("逐笔亏损归因"));
  assert.ok(withLoss.includes("放量突破：2 笔（占 100%）"));
});
