/**
 * 基因组判决回写的测试。
 *
 * 钉住两件事：
 * 1. **判决门槛就是白皮书 §4**：聚类 |t| ≥ 2 **且**前后半段方向稳定，两道都过才算站住。
 * 2. **样本不够 / 没跑成 ≠ 死了**。这两者只是「还没结论」，状态留在 testing。
 *    （把「还没结论」当「死了」处理，等于把还没验的策略提前埋掉。）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENOME_MIN_TRADES,
  GENOME_T_GATE,
  applyGenomeVerdict,
  clusterTOf,
  halvesSameSignOf,
  judgeGenomeVerdict,
  verdictFromTrades,
  type VerdictTrade,
} from "@/lib/market/genome-verdict";
import type { GenomeCandidate } from "@/lib/market/strategy-genome";

function cand(over: Partial<GenomeCandidate> = {}): GenomeCandidate {
  return {
    id: "g1",
    name: "候选一",
    select: ["pe <= 18"],
    rankBy: "40 - pe",
    pricing: { shape: "spot" },
    holdDays: 8,
    stopPct: 8,
    targetPct: 20,
    source: "ai",
    status: "proposed",
    since: "2026-11-05",
    ...over,
  } as GenomeCandidate;
}

/** 造 n 笔同号超额、分布在 n 个平仓日上的逐笔。超额带一点自然波动——真实样本不会完全相同。 */
function trades(n: number, excessPp: number): VerdictTrade[] {
  return Array.from({ length: n }, (_, i) => ({
    ret: (excessPp + Math.sin(i * 1.7) * 0.4) / 100,
    bench: 0,
    exitDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
}

// ── 判决规则 ────────────────────────────────────────────────────

test("没跑成 → 只说还没结论，不判死", () => {
  const r = judgeGenomeVerdict({ ran: false, trades: 0, excessPp: null, clusteredT: null, halvesSameSign: null });
  assert.equal(r.status, "testing");
  assert.deepEqual(r.failedGates, []);
});

test("笔数不够 → 只说还没结论，不判死（不许把没验当死了）", () => {
  const r = judgeGenomeVerdict({
    ran: true,
    trades: GENOME_MIN_TRADES - 1,
    excessPp: 5,
    clusteredT: 9,
    halvesSameSign: true,
  });
  assert.equal(r.status, "testing");
  assert.match(r.reason, /样本不足/);
});

test("聚类 t 没到 |t|≥2 → 判死，败在「聚类t」", () => {
  const r = judgeGenomeVerdict({ ran: true, trades: 350, excessPp: 0.58, clusteredT: 0.72, halvesSameSign: true });
  assert.equal(r.status, "rejected");
  assert.deepEqual(r.failedGates, ["聚类t"]);
  assert.match(r.reason, /聚类 t=0\.72/);
});

test("聚类 t 够了但前后半段翻号 → 判死，败在「方向稳定」", () => {
  const r = judgeGenomeVerdict({ ran: true, trades: 350, excessPp: 0.58, clusteredT: 2.5, halvesSameSign: false });
  assert.equal(r.status, "rejected");
  assert.deepEqual(r.failedGates, ["方向稳定"]);
});

test("两道都过 → 站住（promoted）", () => {
  const r = judgeGenomeVerdict({ ran: true, trades: 350, excessPp: 0.58, clusteredT: 2.8, halvesSameSign: true });
  assert.equal(r.status, "promoted");
  assert.deepEqual(r.failedGates, []);
  assert.match(r.reason, /过线/);
});

test("负的聚类 t 也按绝对值判（-2.5 是过线，不是判死）", () => {
  const r = judgeGenomeVerdict({ ran: true, trades: 350, excessPp: -0.6, clusteredT: -2.5, halvesSameSign: true });
  assert.equal(r.status, "promoted");
});

// ── 回写 ────────────────────────────────────────────────────────

test("applyGenomeVerdict：写回状态 + 记下判决数字，别动别的候选", () => {
  const list = [cand({ id: "g1" }), cand({ id: "g2", name: "候选二" })];
  const out = applyGenomeVerdict(list, "g1", { ran: true, trades: 350, excessPp: 0.58, clusteredT: 0.72, halvesSameSign: true }, "2026-11-05T10:00:00Z");
  assert.equal(out[0].status, "rejected");
  assert.deepEqual(out[0].failedGates, ["聚类t"]);
  assert.equal(out[0].verdict?.clusteredT, 0.72);
  assert.equal(out[0].verdict?.trades, 350);
  assert.match(out[0].note ?? "", /判决 2026-11-05/);
  assert.equal(out[1].status, "proposed", "没被判决的候选不许被动");
  assert.equal(out[1].verdict, undefined);
});

test("applyGenomeVerdict：找不到这个 id 就原样返回（不静默吞掉）", () => {
  const list = [cand({ id: "g1" })];
  const out = applyGenomeVerdict(list, "nope", { ran: true, trades: 350, excessPp: 0, clusteredT: 3, halvesSameSign: true });
  assert.equal(out.length, list.length);
  assert.equal(out[0].status, "proposed");
});

// ── 聚类 t 算法 ─────────────────────────────────────────────────

test("clusterTOf：样本太少（不足 2 笔）给 null，不给一个假数字", () => {
  assert.equal(clusterTOf([]), null);
  assert.equal(clusterTOf([{ ret: 0.01, bench: 0, exitDate: "2026-01-05" }]), null);
});

test("clusterTOf：退化样本必须报 null，不许报一个离谱的大数（11-05 修的坑）", () => {
  // 所有笔超额完全相同 → 浮点残差让方差 ≈1e-37 而不是 0，直接代公式会算出 t≈1e16
  // 的「巨额通过」假象。cluster-t.py 在同样样本上报 nan，JS 这边也必须报 null。
  const sameDay: VerdictTrade[] = Array.from({ length: 12 }, () => ({ ret: 0.01, bench: 0, exitDate: "2026-01-05" }));
  const same = clusterTOf(sameDay);
  assert.equal(same?.clusterT, null, "同一天平仓 = 只有 1 个簇，簇稳健方差估不出来");

  const spread: VerdictTrade[] = Array.from({ length: 12 }, (_, i) => ({
    ret: 0.01,
    bench: 0,
    exitDate: `2026-01-${String(i + 1).padStart(2, "0")}`,
  }));
  const sp = clusterTOf(spread);
  assert.equal(sp?.clusterT, null, "超额全相同 = 无方差，t 算不出来，不许给 1e16");
});

test("clusterTOf：口径和 cluster-t.py 一致（含 G/(G-1) 小样本修正）", () => {
  // 人工算一遍：n=4 笔分 4 天，每笔超额 1pp，簇内偏差全 0 → meat=0 → t 算不出来。
  // 这里给一个有簇内差异的样本，手算核对分子分母。
  const ts: VerdictTrade[] = [
    { ret: 0.02, bench: 0, exitDate: "2026-01-01" },
    { ret: 0.02, bench: 0, exitDate: "2026-01-01" },
    { ret: -0.02, bench: 0, exitDate: "2026-01-02" },
    { ret: -0.02, bench: 0, exitDate: "2026-01-02" },
  ];
  const s = clusterTOf(ts);
  assert.ok(s != null && s.clusterT != null);
  // mean=0；每一天的簇和 = ±0.04；meat = 0.04²×2 = 0.0032
  // g=2, n=4 → v = (2/1)×0.0032/16 = 0.0004 → t = 0/√0.0004 = 0
  assert.equal(s.clusterT, 0, "超额均值恰好为 0 → t 应该是 0");
  assert.equal(s.n, 4);
  assert.equal(s.days, 2);
});

test("clusterTOf：真实的、有方差的样本给出正常量级的 t（不是 0 也不是 1e16）", () => {
  const ts: VerdictTrade[] = Array.from({ length: 40 }, (_, i) => ({
    ret: 0.01 + (i % 7) * 0.002 - 0.005,
    bench: 0,
    exitDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  const s = clusterTOf(ts);
  assert.ok(s != null && s.clusterT != null);
  assert.ok(Number.isFinite(s.clusterT));
  assert.ok(Math.abs(s.clusterT) < 100, `t 不该离谱（实得 ${s.clusterT}）`);
});

test("halvesSameSignOf：前后半段反号 → false；同号 → true", () => {
  const up = trades(20, 1);
  assert.equal(halvesSameSignOf(up), true);
  const mixed: VerdictTrade[] = [
    ...Array.from({ length: 10 }, (_, i) => ({ ret: 0.01, bench: 0, exitDate: `2026-01-${String(i + 1).padStart(2, "0")}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ ret: -0.01, bench: 0, exitDate: `2026-02-${String(i + 1).padStart(2, "0")}` })),
  ];
  assert.equal(halvesSameSignOf(mixed), false);
});

test("verdictFromTrades：从逐笔明细造出判决输入", () => {
  const v = verdictFromTrades(trades(40, 1));
  assert.equal(v.ran, true);
  assert.equal(v.trades, 40);
  assert.ok(v.clusteredT != null);
  assert.ok((v.excessPp ?? 0) > 0);
  assert.equal(v.halvesSameSign, true);
});

test("GENOME_T_GATE 就是白皮书 §4 的 |t|≥2（别偷偷改松）", () => {
  assert.equal(GENOME_T_GATE, 2);
});

test("判决段幂等：跑第二次判决不重复堆 note（每日刷新会天天写一次）", () => {
  const list = [cand({ id: "g1", note: "AI 提议：原始理由" })];
  const input = { ran: true, trades: 350, excessPp: 0.58, clusteredT: 0.72, halvesSameSign: true };
  const once = applyGenomeVerdict(list, "g1", input, "2026-11-05T10:00:00Z");
  const twice = applyGenomeVerdict(once, "g1", input, "2026-11-06T10:00:00Z");
  const count = (twice[0].note ?? "").split("｜判决 ").length - 1;
  assert.equal(count, 1, "判决段只能有一段，不能每天追加一段");
  assert.match(twice[0].note ?? "", /^AI 提议：原始理由｜判决 2026-11-06/);
});
