/**
 * 这个文件是干什么的：
 * 钉住因子页视图层的三个容易骗自己的地方：
 *   1. 「这关没做」不能被渲染成「这关没过」——缺的样子就是缺
 *   2. 旧批次没落判据原话时，不能拿数字凑一句出来
 *   3. 过关计数不能把 null 算成过或没过
 * 这三条读代码都看不出来，只能靠测试钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { factorRows, batchSummary, flowStress, GATE_KEYS } from "@/lib/market/factors-view";
import type { FactorRunRow, FlowProbeDiag } from "@/lib/market/factor-runs-file";

function run(overrides: Partial<FactorRunRow> = {}): FactorRunRow {
  return {
    at: "2026-10-07T04:29:53.000Z",
    factor: "shrinkDays",
    name: "缩量天数",
    direction: -1,
    n: 10,
    buckets: 5,
    offset: 0,
    nDays: 240,
    meanSpread: -0.0055,
    t: -4.35,
    topBlockedRatio: 0.27,
    bucketMeans: [0.004, 0.0016, 0.0016, 0.0001, -0.0015],
    resampleSpread: -0.006,
    resampleT: -2.1,
    gates: { g1: true, g2: true, g3: false, g4: true, g5: true, g6: true },
    gateDetails: {
      g1: "Spearman=-1.00，方向符合预注册反向",
      g2: "t=-4.35",
      g3: "前 -0.62%(-2.25) / 后 0.96%(1.39)（翻号）",
      g4: "原 -0.55% / 换样本 -0.48%(-2.31)",
      g5: "|t|= 4.35 vs 临界 3.09（N=25）",
      g6: "顶档被挡 27%（阈值 ≤50%）",
    },
    nTested: 25,
    ...overrides,
  };
}

test("预注册理由从因子注册表取，取到就带出来", () => {
  const [row] = factorRows([run()]);
  assert.equal(row.rationaleMissing, false);
  assert.ok(row.rationale.length > 5, "缩量天数在注册表里有理由");
  assert.equal(row.category, "量能");
});

test("注册表里查不到的因子，明说没预注册，不编一句理由", () => {
  const [row] = factorRows([run({ factor: "根本没这个因子", name: "幽灵因子" })]);
  assert.equal(row.rationaleMissing, true, "查不到就要标出来，别拿 name 糊过去");
  assert.equal(row.rationale, "");
  assert.equal(row.category, "—");
});

test("G4 没做是 null 不是 false，而且不计入「过了几关」", () => {
  // 资金流探路这次确实没做换样本，日志里 gates 和 gateDetails 都压根没写 g4 这个键。
  // （两个都要去掉——只去 gates 会留下 gateDetails 里的原话，那是自相矛盾的假数据。）
  const [row] = factorRows([
    run({
      gates: { g1: true, g2: true, g3: false, g5: true, g6: true },
      gateDetails: { g1: "a", g2: "b", g3: "c", g5: "d", g6: "e" },
    }),
  ]);
  const g4 = row.gates.find((g) => g.key === "g4");
  assert.equal(g4?.pass, null, "没做的关是 null，不是 false");
  assert.match(g4?.detail ?? "", /没做/);
  // 过了 g1/g2/g5/g6 共 4 关；g4 的 null 既不算过也不算没过
  assert.equal(row.passed, 4);
  assert.equal(row.allPass, false, "有 null 就不可能算全过");
});

test("旧批次没落判据原话：保留 ✓/✗，但 detail 要说清是没记，不编数字", () => {
  const [row] = factorRows([run({ gateDetails: undefined })]);
  for (const gate of row.gates) {
    assert.match(gate.detail, /旧批次|这次没做/, `G${gate.key} 缺原话时要说明原因`);
    assert.ok(!/\d/.test(gate.detail) || gate.pass === null, "没有原话就不该出现具体数字");
  }
  // ✓/✗ 本身照旧来自 gates，不能因为没原话就全变 null
  assert.equal(row.gates.find((g) => g.key === "g1")?.pass, true);
  assert.equal(row.gates.find((g) => g.key === "g3")?.pass, false);
});

test("按 |t| 降序排，最强的在最前面", () => {
  const views = factorRows([
    run({ factor: "chg", name: "当日涨幅", t: 0.39 }),
    run({ factor: "shrinkDays", name: "缩量天数", t: -4.35 }),
    run({ factor: "floatCap", name: "流通市值", t: 4.44 }),
  ]);
  assert.deepEqual(
    views.map((v) => v.id),
    ["floatCap", "shrinkDays", "chg"],
    "4.44 > 4.35 > 0.39",
  );
});

test("过关计数：25 个里 0 个全过，只差一关的单独列出来", () => {
  // 造 25 个：一个都不全过，其中两个只差一关
  const rows = Array.from({ length: 25 }, (_, i) =>
    run({
      factor: i < 2 ? `near${i}` : `f${i}`,
      name: `因子${i}`,
      t: i,
      gates:
        i < 2
          ? { g1: true, g2: true, g3: true, g4: true, g5: true, g6: false } // 只差 G6
          : { g1: false, g2: false, g3: false, g4: false, g5: false, g6: true },
    }),
  );
  const summary = batchSummary(rows);
  assert.equal(summary.total, 25);
  assert.equal(summary.passed, 0, "0 个全过——这个数字要放大给人看，不许藏");
  assert.equal(summary.nearMiss.length, 2, "只差一关的有两个");
  assert.equal(summary.strongest?.t, 24, "|t| 最大的在最前");
});

test("只有一个因子且全过时，passed 是 1", () => {
  const summary = batchSummary([run({ gates: { g1: true, g2: true, g3: true, g4: true, g5: true, g6: true } })]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.nearMiss.length, 0);
});

test("持有期压测：按 N 升序，缺持有期不补 0", () => {
  const probe = (n: number, neutT: number): FlowProbeDiag => ({
    kind: "flowProbe",
    at: `2026-10-07T0${n}:00:00.000Z`,
    n,
    buckets: 5,
    effectiveDays: 120,
    cacheHit: 296,
    cacheTotal: 296,
    factors: [
      {
        id: "mainRatio5",
        name: "主力5日累计占比",
        direction: 1,
        spread: 0.0069,
        t: 3.05,
        nDays: 125,
        topBlockedRatio: 0.3,
        bucketMeans: [0, 0, 0, 0, 0],
        gates: { g1: true, g2: true, g3: false, g5: true, g6: true },
        gateDetails: {},
        neutSpread: 0.0052,
        neutT,
        neutDays: 125,
      },
    ],
  });
  // 故意乱序 + 只有 N=10 的独立 t 过 2
  const out = flowStress([probe(20, 0.71), probe(5, 1.65), probe(10, 2.24)]);
  assert.deepEqual(
    out.map((g) => g.n),
    [5, 10, 20],
    "要按持有期升序，不然「只在 N=10 过 2」看不出来",
  );
  const indep = out.map((g) => g.rows[0].independent);
  assert.deepEqual(indep, [false, true, false], "只有 N=10 的独立 t 过 2");
});

test("六关的 key 顺序和页面表头一致", () => {
  assert.deepEqual(GATE_KEYS, ["g1", "g2", "g3", "g4", "g5", "g6"]);
});
