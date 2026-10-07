/**
 * 这个文件是干什么的：
 * 钉住因子注册表和 6 关判决的行为。这些是纯函数，不碰网络、不碰环境变量，
 * 所以能直接单测——6 关判据本身对不对（单调性、Bonferroni 阈值、两段同号），
 * 是「让策略真的赚到钱」这条链路上最容易被人为调松的一环，必须钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FACTORS,
  analyzeFactors,
  gateMonotonic,
  gateT,
  gateHalves,
  gateResample,
  gateBonferroni,
  gateTradable,
  zCritical,
  bonferroniThreshold,
  type FactorRun,
} from "@/lib/market/factors";

function run(meanSpread: number, t: number, bucketMeans = [0, 0, 0, 0, 0]): FactorRun {
  return { bucketMeans, meanSpread, t, nDays: 200, topBlockedRatio: 0 };
}

test("因子注册表：每个因子都有方向假设和经济逻辑（预注册）", () => {
  assert.ok(FACTORS.length >= 20, "因子池应该已经扩到 20+ 个");
  for (const f of FACTORS) {
    assert.ok(f.id, `因子 ${f.name} 缺 id`);
    assert.ok([1, -1].includes(f.direction), `因子 ${f.name} 的方向假设没标`);
    assert.ok(f.rationale.length > 5, `因子 ${f.name} 缺经济逻辑`);
    assert.equal(typeof f.get, "function", `因子 ${f.name} 缺 getter`);
  }
  // 老 8 因子必须在，且 get 语义不变（保证和 baseline 对得上）
  const ids = FACTORS.map((f) => f.id);
  for (const legacy of ["chg", "d5", "d20", "d60", "volRatio", "volShrink", "amountWan", "c"]) {
    assert.ok(ids.includes(legacy), `老因子 ${legacy} 不能丢`);
  }
  // 2026-10-06 新扩充的三个因子也要在，方向预注册为反向（超跌/低波动异象）
  for (const added of ["lowerWick", "volCompress", "downStreak"]) {
    assert.ok(ids.includes(added), `新因子 ${added} 要注册`);
  }
  for (const f of FACTORS.filter((x) => ["lowerWick", "volCompress", "downStreak"].includes(x.id))) {
    assert.equal(f.direction, -1, `新因子 ${f.id} 预注册方向应为反向`);
  }
});

test("analyzeFactors：正相关因子应该分档单调、顶底 spread 为正", () => {
  const daily = [];
  for (let day = 0; day < 2; day += 1) {
    const today = [];
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: i * 0.01, tradable: true });
    daily.push(today);
  }
  const runs = analyzeFactors(daily, 1, 5);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].bucketMeans.length, 5);
  assert.ok(runs[0].meanSpread > 0, "顶档超额应该高于底档");
  for (let b = 1; b < 5; b += 1) {
    assert.ok(runs[0].bucketMeans[b] > runs[0].bucketMeans[b - 1], "分档应单调递增");
  }
});

test("analyzeFactors：顶档被挡比例统计的是 tradable=false 的占比", () => {
  const daily = [];
  for (let day = 0; day < 2; day += 1) {
    const today = [];
    // 值越大越可交易（前 40 可交易、后 20 不可交易）→ 顶档（值最大）里不可交易比例高
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: 0, tradable: i < 40 });
    daily.push(today);
  }
  const runs = analyzeFactors(daily, 1, 5);
  assert.ok(runs[0].topBlockedRatio > 0.5, "顶档（值最大的 12 只）里应该有一大半被挡");
});

test("G1 单调性：方向符合预注册才算过", () => {
  const up = [0.001, 0.002, 0.003, 0.004, 0.005];
  const down = [0.005, 0.004, 0.003, 0.002, 0.001];
  const messy = [0.001, 0.005, 0.002, 0.004, 0.003];
  assert.equal(gateMonotonic(up, 1).pass, true, "递增 + 正向假设应过");
  assert.equal(gateMonotonic(up, -1).pass, false, "递增 + 反向假设应不过");
  assert.equal(gateMonotonic(down, -1).pass, true, "递减 + 反向假设应过");
  assert.equal(gateMonotonic(messy, 1).pass, false, "非单调应不过");
});

test("G2：|t| 不到 2 就是没测出来", () => {
  assert.equal(gateT(2.1).pass, true);
  assert.equal(gateT(-2.1).pass, true);
  assert.equal(gateT(1.5).pass, false);
});

test("G3 两段：同号且各自 |t|≥1 才过", () => {
  assert.equal(gateHalves(run(0.01, 2), run(0.008, 1.5)).pass, true, "两段同号都强 → 过");
  assert.equal(gateHalves(run(0.01, 2), run(-0.008, 1.5)).pass, false, "翻号 → 不过");
  assert.equal(gateHalves(run(0.01, 2), run(0.008, 0.5)).pass, false, "后半段太弱 → 不过");
});

test("G4 换样本：换一批票仍同号且 |t|≥2 才过", () => {
  assert.equal(gateResample(run(0.01, 3), run(0.009, 2.5)).pass, true);
  assert.equal(gateResample(run(0.01, 3), run(-0.009, 2.5)).pass, false, "换样本翻号 → 不过");
});

test("G5 Bonferroni：因子越多，临界越高（多重比较会自我收紧）", () => {
  const t8 = bonferroniThreshold(8);
  const t30 = bonferroniThreshold(30);
  assert.ok(t30 > t8, "测 30 个因子的临界必须比测 8 个更严");
  assert.ok(t8 > 2.4 && t8 < 2.8, `N=8 临界应在 2.5 附近，实际 ${t8}`);
  assert.equal(gateBonferroni(3.0, 8).pass, true);
  assert.equal(gateBonferroni(2.5, 30).pass, false, "同样的 t 在 30 个因子里不再显著");
});

test("G6 可交易：顶档被挡过半就不可交易", () => {
  assert.equal(gateTradable(0.2).pass, true);
  assert.equal(gateTradable(0.6).pass, false);
});

test("zCritical：标准正态分位数对照已知值", () => {
  assert.ok(Math.abs(zCritical(0.025) - 1.96) < 0.01, "双侧 5% 单侧 ≈ 1.96");
  assert.ok(Math.abs(zCritical(0.00135) - 3.0) < 0.02, "3σ ≈ 3.0");
});
