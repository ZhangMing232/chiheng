import { test } from "node:test";
import assert from "node:assert/strict";
import { medianRank, temperatureOf, phaseOf, tierOf, promotion, transferMatrix, nextDayOutcome, type DayStat, type Phase } from "./cycle.ts";

test("medianRank：中位秩口径，全等给 50，最小给 0 附近", () => {
  assert.equal(medianRank([5, 5, 5], 5), 50);
  assert.equal(medianRank([1, 2, 3, 4], 0), 0);
  // 最大值：严格小于 3 个 + 0.5×相等 1 个 = 3.5 / 4 = 87.5（不是 100，中位秩就是这样）
  assert.equal(medianRank([1, 2, 3, 4], 4), 87.5);
  assert.equal(medianRank([], 7), 50, "空窗口给中性 50，不是 0");
});

test("medianRank 不许前视：窗口只到当日，后面追加数据不改变历史分位", () => {
  const hist = [1, 4, 2, 8, 5, 7];
  const value = 6;
  const before = medianRank(hist, value);
  // 未来数据接入历史后再算同一天（窗口仍然截止到那天）
  const withFuture = [...hist, 100, 200];
  const after = medianRank(withFuture.slice(0, hist.length), value);
  assert.equal(before, after);
  // 反证：如果误用整段历史，分位一定会变小（多了两个更大的值）
  assert.notEqual(medianRank(withFuture, value), before);
});

test("temperatureOf：样本不足 120 天直接给 null，不拿半截样本凑分", () => {
  const day = { limitUp: 50, ladder: 10, maxStreak: 3, up: 2000, down: 3000 };
  assert.equal(temperatureOf(day, []), null);
  const short = Array.from({ length: 119 }, () => day);
  assert.equal(temperatureOf(day, short), null);
  const enough = Array.from({ length: 120 }, (_, i) => ({ ...day, limitUp: 20 + (i % 40) }));
  const t = temperatureOf(day, enough);
  assert.ok(t != null && t >= 0 && t <= 100);
});

test("temperatureOf：全历史都一样的日子 = 无信息，温度应该是中性 50 附近", () => {
  const day = { limitUp: 50, ladder: 10, maxStreak: 3, up: 2000, down: 3000 };
  const flat = Array.from({ length: 200 }, () => day);
  assert.equal(temperatureOf(day, flat), 50);
});

test("phaseOf：六档分界清楚，温度缺失返回 null", () => {
  assert.equal(phaseOf(null, 5), null);
  assert.equal(phaseOf(10, -5), "冰点");
  assert.equal(phaseOf(35, 1), "修复");
  assert.equal(phaseOf(35, -1), "退潮");
  assert.equal(phaseOf(60, 0), "升温", "温度持平算升温这一侧（>=0）");
  assert.equal(phaseOf(60, -2), "降温");
  assert.equal(phaseOf(90, -9), "高潮", "高潮优先于方向：温度极高就是高潮");
});

test("tierOf：首板计入 1，超 9 板并到 9，非正数忽略", () => {
  assert.deepEqual(tierOf([1, 1, 2, 3]), { "1": 2, "2": 1, "3": 1 });
  assert.deepEqual(tierOf([10, 12]), { "9": 2 });
  assert.deepEqual(tierOf([0, -1]), {});
});

test("promotion：分母是昨日同板位家数，晋级数不许超过分母", () => {
  assert.deepEqual(promotion({ "2": 4 }, { "3": 2 }, 2), { total: 4, promoted: 2, rate: 0.5 });
  // 脏数据：今天 3 板比昨天 2 板还多 → 夹到分母，不许出现 150% 的晋级率
  assert.deepEqual(promotion({ "2": 2 }, { "3": 5 }, 2), { total: 2, promoted: 2, rate: 1 });
  assert.deepEqual(promotion({}, { "3": 1 }, 2), { total: 0, promoted: 0, rate: null });
});

function day(date: string, phase: Phase, eqReturn = 0): DayStat {
  return {
    date,
    limitUp: 50,
    ladder: 10,
    maxStreak: 3,
    byTier: { "1": 40, "2": 8, "3": 2 },
    up: 2000,
    down: 3000,
    eqReturn,
    n: 5000,
    temp: 50,
    phase,
    tempDelta5: 0,
  };
}

test("transferMatrix：每一行的占比加起来是 1（有样本的前提下）", () => {
  const series = [
    day("2026-11-03", "冰点"),
    day("2026-11-04", "修复"),
    day("2026-11-05", "升温"),
    day("2026-11-06", "升温"),
    day("2026-11-09", "降温"),
    day("2026-11-10", "退潮"),
    day("2026-11-11", "冰点"),
  ];
  const cells = transferMatrix(series);
  assert.equal(cells.length, 6 * 6);
  for (const from of ["冰点", "修复", "升温", "高潮", "降温", "退潮"] as Phase[]) {
    const row = cells.filter((c) => c.from === from);
    const total = row.reduce((n, c) => n + c.count, 0);
    if (total === 0) continue;
    const sum = row.reduce((n, c) => n + c.rate, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${from} 行占比应为 1，实际 ${sum}`);
  }
});

test("nextDayOutcome：次日收益取的是下一天，不是当天（差一天就是前视）", () => {
  const series = [
    day("2026-11-05", "冰点", 0.05), // 当天大涨，不是"次日"要看的那个
    day("2026-11-06", "冰点", 0.02),
    day("2026-11-09", "冰点", -0.01),
    day("2026-11-10", "冰点", 0.03),
  ];
  const r = nextDayOutcome(series, "冰点");
  // 前三天是"冰点"，次日收益 = 0.02 / -0.01 / 0.03
  assert.equal(r.n, 3);
  assert.ok(Math.abs((r.mean ?? 0) - (0.02 - 0.01 + 0.03) / 3) < 1e-9);
  assert.ok(Math.abs((r.winRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(r.reliable, false, "n<30 必须标不可靠");
});

test("nextDayOutcome：样本 <30 永远 reliable=false，不许拿 3 个样本说结论", () => {
  const series = Array.from({ length: 20 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, "升温", 0.01));
  const r = nextDayOutcome(series, "升温");
  assert.equal(r.n, 19);
  assert.equal(r.reliable, false);
});
