/**
 * 策略基因组轨道的纯函数测试：因子→策略融合、prompt 含已通过因子、近亲封禁。
 * 这些都不碰网络/文件，纯逻辑，直接单测。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  specFromFactor,
  buildGenomePrompt,
  signatureOverlap,
  specSignature,
  isNearTwin,
  parseGenomeProposals,
  type GenomeCandidate,
  type GenomeContext,
} from "@/lib/market/strategy-genome";
import type { StrategySpec } from "@/lib/market/strategies";

function spec(over: Partial<StrategySpec> = {}): StrategySpec {
  return {
    id: "x",
    name: "X",
    select: ["pe <= 18"],
    rankBy: "40 - pe",
    pricing: { shape: "spot" },
    holdDays: 8,
    stopPct: 8,
    targetPct: 20,
    source: "manual",
    ...over,
  };
}

function candidate(over: Partial<GenomeCandidate> = {}): GenomeCandidate {
  return {
    ...spec({ id: over.id ?? "a", name: over.name ?? "A" }),
    ...over,
    status: over.status ?? "proposed",
    since: over.since ?? "2026-11-05",
    source: over.source ?? "ai",
  } as GenomeCandidate;
}

// ── 因子→策略融合 ──────────────────────────────────────────────

test("specFromFactor：因子表达式能在 spec 上下文编译 → 熔成种子 spec", () => {
  const r = specFromFactor({ id: "d60", name: "60日涨幅", expr: "d60", direction: -1, rationale: "中期反转" });
  assert.equal(r.ok, true);

  if (!r.ok) return;
  assert.equal(r.spec.id, "fused_d60");
  assert.deepEqual(r.spec.select, ["d60 < 0"]);
  assert.equal(r.spec.rankBy, "0 - (d60)");
  assert.equal(r.spec.pricing.shape, "spot");
});

test("specFromFactor：因子表达式含 spec 上下文没有的变量 → 不硬熔，返回原因", () => {
  const r = specFromFactor({ id: "vol", name: "量波", expr: "std20 / amp20", direction: -1, rationale: "x" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /spec 上下文没有的变量/);
});

// ── buildGenomePrompt 含已通过因子 ───────────────────────────────

test("buildGenomePrompt：带 passedFactors 时列出可融合的因子", () => {
  const ctx: GenomeContext = {
    factorTombstones: [],
    rejectedChallengers: [],
    deadSpecs: [],
    liveSpecs: [],
    gateLines: [],
    passedFactors: [
      { id: "d60", name: "60日涨幅", expr: "d60", direction: -1, rationale: "中期反转" },
      { id: "volShrink", name: "缩量", expr: "volShrink", direction: -1, rationale: "抛压衰竭" },
    ],
  };
  const prompt = buildGenomePrompt(ctx);
  assert.match(prompt, /已通过 6 关的因子/);
  assert.match(prompt, /d60/);
  assert.match(prompt, /volShrink/);
  assert.match(prompt, /融合/);
});

// ── 近亲 / 同家族封禁（spec 级，治「换汤不换药」）────────────────

test("signatureOverlap：相同选股结构重叠=1，不同变量<1", () => {
  const a = spec({ select: ["pe <= 18"], rankBy: "40 - pe" });
  const b = spec({ select: ["pe <= 20"], rankBy: "30 - pe" }); // 只换常数
  const c = spec({ select: ["pb < 2"], rankBy: "30 - pe" }); // 换变量
  assert.equal(signatureOverlap(specSignature(a), specSignature(b)), 1);
  assert.ok(signatureOverlap(specSignature(a), specSignature(c)) < 1);
});

test("isNearTwin：同结构只换常数的 spec 判近亲；换变量不算", () => {
  const existing = [spec({ id: "a", select: ["pe <= 18"], rankBy: "40 - pe" })];
  const twin = spec({ id: "b", select: ["pe <= 22"], rankBy: "50 - pe" });
  const fresh = spec({ id: "c", select: ["pb < 2"], rankBy: "50 - pe" });
  assert.equal(isNearTwin(twin, existing).twin, true);
  assert.equal(isNearTwin(fresh, existing).twin, false);
});

test("parseGenomeProposals：选股逻辑和已有 spec 近亲的提案直接拒", () => {  const existing = [candidate({ id: "a", select: ["pe <= 18"], rankBy: "40 - pe" })];
  const raw = JSON.stringify([
    // 只换常数 → 近亲
    { id: "bb", name: "SpecB", select: ["pe <= 22"], rankBy: "50 - pe", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "和 A 一样只是换了常数阈值没有换思路" },
    // 换变量 → 接受
    { id: "cc", name: "SpecC", select: ["pb < 2"], rankBy: "50 - pe", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "换了估值维度来选股，不是 A 的近亲" },
  ]);
  const { accepted, rejected } = parseGenomeProposals(raw, existing);
  assert.equal(accepted.length, 1, "只有换变量的 C 被接受");
  assert.equal(accepted[0].id, "cc");
  assert.equal(rejected.length, 1, "B 因近亲被拒");
  assert.match(rejected[0].reason, /近亲/);
});

test("可判性闸：用回测取不到的变量（inflow/ytd）的提案直接拒，并告诉它能用什么", () => {
  const raw = JSON.stringify([
    { id: "aa", name: "SpecA", select: ["inflow > 0"], rankBy: "40 - pe", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "用了回测没有的主力净流入，这条永远判不了" },
    { id: "bb", name: "SpecB", select: ["pe <= 18"], rankBy: "40 - pe", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "用回测取得到的变量，可以判" },
  ]);
  const { accepted, rejected } = parseGenomeProposals(raw, []);
  assert.equal(accepted.length, 1, "只有用可判变量的 B 被接受");
  assert.equal(accepted[0].id, "bb");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /inflow/);
  assert.match(rejected[0].reason, /永远判不了/);
  assert.match(rejected[0].reason, /只能用这些变量/, "拒的时候要说清能用什么");
});

test("buildGenomePrompt：告诉 AI 哪些变量回测能判（省得提一堆判不了的）", () => {
  const ctx: GenomeContext = {
    factorTombstones: [],
    rejectedChallengers: [],
    deadSpecs: [],
    liveSpecs: [],
    gateLines: [],
    passedFactors: [],
  };
  const prompt = buildGenomePrompt(ctx);
  assert.match(prompt, /只能用回测能判的变量/);
  assert.match(prompt, /不许用：inflow、ytd/);
});

test("溯源：AI 声明的 seededFrom 因子 id 要留住（非字符串的丢掉）", () => {
  const raw = JSON.stringify([
    { id: "cc", name: "SpecC", select: ["pe <= 18"], rankBy: "40 - pe", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "用了已过 6 关的因子做选股条件", seededFrom: ["shrinkDays", 123, null] },
  ]);
  const { accepted, rejected } = parseGenomeProposals(raw, []);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 0);
  assert.deepEqual(accepted[0].seededFrom, ["shrinkDays"], "只留字符串 id，数字/null 丢掉");
});

test("溯源：没声明 seededFrom 就是没融合，不硬凑", () => {
  const raw = JSON.stringify([
    { id: "dd", name: "SpecD", select: ["pb <= 2"], rankBy: "pb", pricing: { shape: "spot" }, holdDays: 8, stopPct: 8, targetPct: 20, rationale: "没用任何已过 6 关的因子，纯新思路" },
  ]);
  const { accepted } = parseGenomeProposals(raw, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].seededFrom, undefined, "没声明就不该有 seededFrom");
});

test("溯源：prompt 里要求 AI 声明用了哪些因子（不然页面接不上线）", () => {
  const ctx: GenomeContext = {
    factorTombstones: [], rejectedChallengers: [], deadSpecs: [], liveSpecs: [], gateLines: [],
    passedFactors: [{ id: "shrinkDays", name: "缩量天数", expr: "shrinkDays", direction: 1, rationale: "量能萎缩" }],
  };
  const prompt = buildGenomePrompt(ctx);
  assert.match(prompt, /seededFrom/);
  assert.match(prompt, /缩量天数/, "已过 6 关的因子要列进 prompt，AI 才知道能融哪个");
});
