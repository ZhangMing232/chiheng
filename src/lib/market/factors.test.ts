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
  return {
    bucketMeans,
    meanSpread,
    t,
    nDays: 200,
    topBlockedRatio: 0,
    spreadSkew: null,
    spreadKurt: null,
    icMean: null,
    icir: null,
    icDays: 0,
    icPositiveRatio: null,
  };
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

test("威科夫Spring 已注册，且上一版失败的 wyckoffAccum 已下线", () => {
  const ids = FACTORS.map((f) => f.id);
  assert.ok(ids.includes("springStrength"), "Spring 因子要注册");
  // 失败的乘积版不能留着当「备选」——那等于给自己留一个回头调参的后门
  assert.ok(!ids.includes("wyckoffAccum"), "wyckoffAccum 必须删掉");
  const spring = FACTORS.find((f) => f.id === "springStrength");
  assert.ok(spring);
  assert.equal(spring.direction, 1, "强度越大越好，预注册方向应为正向");
  // 这两处是「刻意偏离威科夫原文」的地方，删了就等于把已验证的负收益条件请回来
  assert.ok(spring.rationale.includes("刻意偏离"), "rationale 必须写清刻意偏离原文");
  assert.ok(spring.rationale.includes("缩量"), "rationale 必须写清缩量条件是反的");
  assert.ok(spring.rationale.includes("G6"), "rationale 必须预披露 G6 风险");
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

test("IC/ICIR：完美正相关因子 → |IC|≈1、正占比 100%；零波动时 ICIR 记 null 不编数", () => {
  const daily = [];
  for (let day = 0; day < 10; day += 1) {
    const today = [];
    // 值与次日超额严格单调同向 → 每天横截面 Spearman = 1
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: i * 0.001, tradable: true });
    daily.push(today);
  }
  const [r] = analyzeFactors(daily, 1, 5);
  assert.ok(Math.abs((r.icMean as number) - 1) < 1e-9, `IC 应≈1，实际 ${r.icMean}`);
  assert.equal(r.icir, null, "IC 序列零波动时 ICIR 除不出来，记 null 而不是编一个无穷大");
  assert.equal(r.icDays, 10);
  assert.equal(r.icPositiveRatio, 1);
});

test("IC/ICIR：一半天正相关一半天反相关 → IC 均值为 0、ICIR=0、正占比 50%", () => {
  const daily = [];
  for (let day = 0; day < 10; day += 1) {
    const today = [];
    const sign = day % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: sign * i * 0.001, tradable: true });
    daily.push(today);
  }
  const [r] = analyzeFactors(daily, 1, 5);
  assert.ok(Math.abs(r.icMean as number) < 1e-9, `IC 均值应≈0，实际 ${r.icMean}`);
  assert.ok(Math.abs(r.icir as number) < 1e-9, `ICIR 应≈0（均值 0/有波动的标准差），实际 ${r.icir}`);
  assert.equal(r.icDays, 10);
  assert.equal(r.icPositiveRatio, 0.5);
});

test("IC/ICIR：值与超额严格反相关 → IC≈−1，方向由 direction 承担不由 IC 翻转", () => {
  const daily = [];
  for (let day = 0; day < 10; day += 1) {
    const today = [];
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: -i * 0.001, tradable: true });
    daily.push(today);
  }
  const [r] = analyzeFactors(daily, 1, 5);
  assert.ok(Math.abs((r.icMean as number) + 1) < 1e-9, `IC 应≈−1（原始方向存），实际 ${r.icMean}`);
});

test("IC/ICIR：序列不足 IC_MIN_DAYS 天 → 均值/ICIR 为 null，天数照实记", () => {
  const daily = [];
  for (let day = 0; day < 3; day += 1) {
    const today = [];
    for (let i = 0; i < 60; i += 1) today.push({ vals: [i], ex: i * 0.001, tradable: true });
    daily.push(today);
  }
  const [r] = analyzeFactors(daily, 1, 5);
  assert.equal(r.icMean, null);
  assert.equal(r.icir, null);
  assert.equal(r.icPositiveRatio, null);
  assert.equal(r.icDays, 3);
});

test("IC/ICIR：横截面票数不足 IC_MIN_PAIRS 的那天不进 IC 序列", () => {
  const daily = [];
  for (let day = 0; day < 10; day += 1) {
    const today = [];
    const n = day === 0 ? 15 : 60; // 第 0 天只有 15 只（< 20），其余天 60 只
    for (let i = 0; i < n; i += 1) today.push({ vals: [i], ex: i * 0.001, tradable: true });
    daily.push(today);
  }
  const [r] = analyzeFactors(daily, 1, 5);
  assert.equal(r.icDays, 9, "15 只的那天分档也不够 50，整体出局——IC 天数按分档同一口径");
  assert.ok(r.icMean != null);
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
