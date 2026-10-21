/**
 * 这个文件是干什么的：
 * 钉住 AI 因子管理的三块纯逻辑——状态机、AI 产出校验、prompt 组装。
 *
 * 为什么值得钉：
 * 1. 淘汰（tombstone）是「连续 2 次没过」——少一次会放过环境依赖的因子，
 *    多一次浪费回测；过关要清零 failCount，不清的话一次过关救不回淘汰线。
 * 2. AI 的产出永远不可信：id 撞名、类别乱写、方向不是 ±1、表达式带白名单外
 *    的函数、economic rationale 敷衍——每一种都要拒掉并写明原因，而且一个被拒
 *    不能中断整批（continue 不是 return——曾经写反过）。
 * 3. prompt 里的败因摘要数字必须原样来自日志行，不许加工。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TOMBSTONE_AFTER,
  updateQueueAfterRun,
  parseAIProposals,
  buildPrompt,
  type QueueEntry,
} from "@/lib/market/factor-queue";
import type { FactorRunRow } from "@/lib/market/factor-runs-file";

function entry(partial: Partial<QueueEntry>): QueueEntry {
  return {
    id: "q_test",
    name: "测试因子",
    category: "波动率",
    direction: -1,
    expr: "std20 / amp20",
    rationale: "测试用的占位经济逻辑",
    source: "ai",
    status: "pending",
    failCount: 0,
    runs: 0,
    createdAt: "2026-10-09T00:00:00Z",
    lastRunAt: null,
    ...partial,
  };
}

test("过关：status=passed，failCount 清零，runs+1", () => {
  const q = [entry({ failCount: 1, status: "tested" })];
  const out = updateQueueAfterRun(q, [{ id: "q_test", passed: true, at: "2026-10-09T01:00:00Z" }]);
  assert.equal(out[0].status, "passed");
  assert.equal(out[0].failCount, 0);
  assert.equal(out[0].runs, 1);
  assert.equal(out[0].lastRunAt, "2026-10-09T01:00:00Z");
  // 不改入参
  assert.equal(q[0].status, "tested");
});

test("第一次失败：tested，failCount=1，不淘汰", () => {
  const out = updateQueueAfterRun([entry({})], [{ id: "q_test", passed: false, at: "t1" }]);
  assert.equal(out[0].status, "tested");
  assert.equal(out[0].failCount, 1);
  assert.notEqual(out[0].status, "tombstone");
});

test(`第二次失败：tombstone，原因写明连续 ${TOMBSTONE_AFTER} 次`, () => {
  const out = updateQueueAfterRun([entry({ failCount: 1, status: "tested" })], [{ id: "q_test", passed: false, at: "t2" }]);
  assert.equal(out[0].status, "tombstone");
  assert.match(out[0].note ?? "", /连续 \d+ 次未过 6 关/);
});

test("过关后再失败重新计数：pass 清零 failCount，不满 2 次不淘汰", () => {
  let q = [entry({})];
  q = updateQueueAfterRun(q, [{ id: "q_test", passed: false, at: "t1" }]);
  q = updateQueueAfterRun(q, [{ id: "q_test", passed: true, at: "t2" }]);
  q = updateQueueAfterRun(q, [{ id: "q_test", passed: false, at: "t3" }]);
  assert.equal(q[0].status, "tested");
  assert.equal(q[0].failCount, 1);
});

test("没出现在 verdicts 里的条目原样保留", () => {
  const other = entry({ id: "q_other" });
  const out = updateQueueAfterRun([entry({}), other], [{ id: "q_test", passed: true, at: "t" }]);
  assert.equal(out[1], other);
});

// ── parseAIProposals ────────────────────────────────────────────

// 每次调用拿一份新的——parseAIProposals 会往里 add 已接受的 id/name，
// 共享同一份会在测试之间互相污染（「一个被拒不中断整批」曾经因此被误拒）。
const empty = () => ({ ids: new Set<string>(), names: new Set<string>() });

test("合格的 JSON 被接受，围上 ```json 围栏也能解", () => {
  const raw = '```json\n[{"id":"q_lcap","name":"大市值溢价","category":"规模","direction":1,"expr":"log(floatCap)","rationale":"最大市值档超额独好，按真实形状重新登记为正向因子"}]\n```';
  const { accepted, rejected } = parseAIProposals(raw, empty());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "q_lcap");
  assert.equal(accepted[0].source, "ai");
  assert.equal(rejected.length, 0);
});

test("id 撞已有的、name 撞已有的、批次内自撞，都拒", () => {
  const raw = JSON.stringify([
    { id: "d60", name: "甲", category: "反转", direction: -1, expr: "d60", rationale: "足够长的经济逻辑说明" },
    { id: "q_x", name: "缩量天数", category: "量能", direction: -1, expr: "shrinkDays", rationale: "足够长的经济逻辑说明" },
    { id: "q_x", name: "乙", category: "反转", direction: -1, expr: "d10", rationale: "足够长的经济逻辑说明" },
    { id: "q_x2", name: "乙", category: "反转", direction: -1, expr: "d20", rationale: "足够长的经济逻辑说明" },
  ]);
  const { accepted, rejected } = parseAIProposals(raw, { ids: new Set(["d60"]), names: new Set(["缩量天数"]) });
  assert.equal(accepted.length, 1); // 只有第一个批次内的 q_x/乙 留下
  assert.equal(rejected.length, 3);
});

test("类别不在词表、方向不是 ±1、表达式不过白名单，都拒且写明原因", () => {
  const raw = JSON.stringify([
    { id: "q_a", name: "甲", category: "玄学", direction: 1, expr: "d60", rationale: "足够长的经济逻辑说明" },
    { id: "q_b", name: "乙", category: "动量", direction: 0, expr: "d60", rationale: "足够长的经济逻辑说明" },
    { id: "q_c", name: "丙", category: "动量", direction: 1, expr: "fetch(1)", rationale: "足够长的经济逻辑说明" },
    { id: "q_d", name: "丁", category: "动量", direction: 1, expr: "d60", rationale: "短" },
  ]);
  const { accepted, rejected } = parseAIProposals(raw, empty());
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 4);
  assert.match(rejected[0].reason, /词表/);
  assert.match(rejected[1].reason, /1 或 -1/);
  assert.match(rejected[2].reason, /不过编译/);
  assert.match(rejected[3].reason, /太短/);
});

test("弱模型自造的组合类别（量能/反转）取主类别后照常接受，纯乱造仍拒", () => {
  const raw = JSON.stringify([
    { id: "q_mix", name: "甲", category: "量能/反转", direction: -1, expr: "std20 / amp20", rationale: "足够长的经济逻辑说明" },
    { id: "q_bad", name: "乙", category: "玄学/动量", direction: 1, expr: "d60", rationale: "足够长的经济逻辑说明" },
  ]);
  const { accepted, rejected } = parseAIProposals(raw, empty());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].category, "量能");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /词表/);
});

test("一个被拒不中断整批：后面合格的照常接受", () => {
  const raw = JSON.stringify([
    { id: "bad!", name: "甲", category: "动量", direction: 1, expr: "d60", rationale: "足够长的经济逻辑说明" },
    { id: "q_ok", name: "乙", category: "波动率", direction: -1, expr: "std20 / amp20", rationale: "单位振幅承载的波动，衡量波动效率" },
  ]);
  const { accepted, rejected } = parseAIProposals(raw, empty());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, "q_ok");
  assert.equal(rejected.length, 1);
});

test("返回里没有 JSON 数组：整批拒绝，不抛", () => {
  const { accepted, rejected } = parseAIProposals("对不起我做不到", empty());
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 1);
});

// ── buildPrompt ─────────────────────────────────────────────────

test("prompt 带上每个因子的败关和五档数字，不加工", () => {
  const rows: FactorRunRow[] = [
    {
      at: "t",
      factor: "floatCap",
      name: "流通市值",
      direction: -1,
      n: 10,
      buckets: 5,
      offset: 0,
      nDays: 100,
      meanSpread: 0.01,
      t: 4.44,
      topBlockedRatio: 0.06,
      bucketMeans: [-0.0052, -0.0022, -0.0026, 0.0104, 0.0052],
      resampleSpread: 0.01,
      resampleT: 4.23,
      gates: { g1: false, g2: true, g3: true, g4: true, g5: true, g6: true },
      nTested: 25,
    },
  ];
  const prompt = buildPrompt(rows);
  assert.match(prompt, /floatCap/);
  assert.match(prompt, /G1/);
  assert.match(prompt, /-0\.52% → -0\.22%/);
  assert.match(prompt, /只输出 JSON 数组/);
});

test("buildPrompt：给了自我历史就追加反馈段，没给不追加", () => {
  const rows: FactorRunRow[] = [];
  const withHistory = buildPrompt(rows, ["- 10-08：你提议「甲」（q_a）——已淘汰", "- 10-09：你提议「乙」（q_b）——已过 6 关"]);
  assert.match(withHistory, /你自己之前几轮提议的下场/);
  assert.match(withHistory, /q_a.*已淘汰/);
  assert.match(withHistory, /q_b.*已过 6 关/);
  const bare = buildPrompt(rows);
  assert.doesNotMatch(bare, /你自己之前几轮提议的下场/);
});

test("buildPrompt：判决行带样本量，老批次没记显示 ?——AI 能分辨证据强度", () => {
  const row = (universe?: number): FactorRunRow => ({
    at: "2026-10-09T13:00:00.000Z",
    factor: "q_amp",
    name: "大市值高振幅放量",
    direction: 1,
    n: 3,
    buckets: 5,
    offset: 0,
    nDays: 247,
    meanSpread: 0.0041,
    t: 2.66,
    topBlockedRatio: 0.1,
    bucketMeans: [0, 0, 0, 0, 0.0041],
    resampleSpread: 0.001,
    resampleT: 1.2,
    gates: { g1: true },
    nTested: 28,
    ...(universe !== undefined ? { universe } : {}),
  });
  const withUniverse = buildPrompt([row(500)]);
  assert.match(withUniverse, /样本500只/);
  const legacy = buildPrompt([row()]);
  assert.match(legacy, /样本\?只/);
});

// ── fallbackCandidates（主档案挂了切备用）─────────────────────────

test("fallbackCandidates：启用档案排第一，其余补位，最多两个", async () => {
  const { fallbackCandidates } = await import("@/lib/market/factor-queue");
  const profiles = [
    { id: "b", baseUrl: "https://b.example.com", apiKey: "k2", model: "m2", pricePromptPerM: 6.5, priceCompletionPerM: 54 },
    { id: "default", baseUrl: "https://a.example.com", apiKey: "k1", model: "m1", pricePromptPerM: 4.7, priceCompletionPerM: 14.1 },
    { id: "c", baseUrl: "https://c.example.com", apiKey: "k3", model: "m3" },
  ];
  const candidates = fallbackCandidates({ activeId: "default", profiles });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].profileId, "default");
  assert.equal(candidates[1].profileId, "b");
  assert.equal(candidates[0].config.model, "m1");
  // 计价钱包跟着各自档案走，不串
  assert.equal(candidates[0].pricePromptPerM, 4.7);
  assert.equal(candidates[1].pricePromptPerM, 6.5);
});

test("fallbackCandidates：缺三件套的不补位；没有启用档案时给顺序第一个", async () => {
  const { fallbackCandidates } = await import("@/lib/market/factor-queue");
  const incomplete = fallbackCandidates({
    activeId: "default",
    profiles: [
      { id: "default", baseUrl: "https://a.example.com", apiKey: "", model: "m1" },
      { id: "b", baseUrl: "https://b.example.com", apiKey: "k2", model: "m2" },
    ],
  });
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].profileId, "b");
  const none = fallbackCandidates({ activeId: "ghost", profiles: [{ id: "b", baseUrl: "https://b.example.com", apiKey: "k2", model: "m2" }] });
  assert.equal(none.length, 1);
  assert.equal(none[0].profileId, "b");
});
