/**
 * challenger-robust（VT3 参数敏感度）单测。
 * 重模拟全部喂手工 K 线，不触网；判决旁路纪律（只标注不改判决）靠 record-journal
 * 侧不把 fragile 接进 judgeChallenger 来保证，这里只测网格、重模拟和报告本身。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  neighborParams,
  simulateMean,
  robustnessReport,
  type ClosedTrade,
  type RobustParams,
} from "@/lib/market/challenger-robust";

type Bar = { date: string; o?: number; h?: number; l?: number; c: number };

/** 横盘 30 天的 K 线：开高低收都一样，什么参数都赚不到钱也亏不到钱（除费用）。 */
function flatBars(start: string, n: number, price = 10): Bar[] {
  const bars: Bar[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < n; i++) {
    bars.push({ date: dt.toISOString().slice(0, 10), o: price, h: price, l: price, c: price });
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return bars;
}

/** 单边涨：每天 +1%，任何出场位都赚，赚得多少看持有天数。 */
function upBars(start: string, n: number, from = 10): Bar[] {
  const bars: Bar[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  let price = from;
  for (let i = 0; i < n; i++) {
    bars.push({ date: dt.toISOString().slice(0, 10), o: price, h: price, l: price, c: price });
    price = Math.round(price * 1.01 * 100) / 100;
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return bars;
}

/** 前 9 天每天 +1%，第 10 天起每天 −6%（远离跌停线，规避封死规则）：
 *  持有 8 天逃顶、持有 10~12 天吃进回调——持有天数是悬崖。 */
function boomThenCrash(start: string, n: number, from = 10): Bar[] {
  const bars: Bar[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  let price = from;
  for (let i = 0; i < n; i++) {
    bars.push({ date: dt.toISOString().slice(0, 10), o: price, h: price, l: price, c: price });
    price = Math.round(price * (i < 9 ? 1.01 : 0.94) * 100) / 100;
    dt.setUTCDate(dt.getUTCDate() + 1);
  }
  return bars;
}

const barsMapOf =
  (map: Record<string, Bar[]>) =>
  async (id: string): Promise<Bar[] | null> =>
    map[id] ?? null;

// ── neighborParams ─────────────────────────────────────────────

test("neighborParams：单旋钮 ±一步，全参数出 6 个邻域", () => {
  const base: RobustParams = { holdDays: 10, stopPct: 10, targetPct: 25 };
  const ns = neighborParams(base);
  assert.equal(ns.length, 6);
  // 每个邻域只动一个旋钮，且相对基准是 ±一步
  for (const n of ns) {
    const diffs = (["holdDays", "stopPct", "targetPct"] as const).filter((k) => n[k] !== base[k]);
    assert.equal(diffs.length, 1);
  }
  assert.ok(ns.some((n) => n.holdDays === 8));
  assert.ok(ns.some((n) => n.holdDays === 12));
  assert.ok(ns.some((n) => n.stopPct === 8));
  assert.ok(ns.some((n) => n.stopPct === 12));
  assert.ok(ns.some((n) => n.targetPct === 20));
  assert.ok(ns.some((n) => n.targetPct === 30));
});

test("neighborParams：没设过的旋钮（null）不出现在任何邻域", () => {
  const base: RobustParams = { holdDays: 10, stopPct: null, targetPct: null };
  const ns = neighborParams(base);
  assert.equal(ns.length, 2); // 只有 holdDays ±2
  assert.ok(ns.every((n) => n.stopPct === null && n.targetPct === null));
});

test("neighborParams：贴着白名单边界的步越界就砍掉", () => {
  const ns = neighborParams({ holdDays: 3, stopPct: 4, targetPct: 60 });
  assert.ok(!ns.some((n) => n.holdDays === 1));
  assert.ok(!ns.some((n) => n.stopPct === 2));
  assert.ok(!ns.some((n) => n.targetPct === 65));
  assert.ok(ns.some((n) => n.holdDays === 5));
});

// ── simulateMean ───────────────────────────────────────────────

test("simulateMean：没 perturbed 的维度用建仓时的记录位", async () => {
  // 只改 holdDays，stop/target 用记录位（9.2 / 12.5）。
  // 涨单边上，持有越久赚越多 → 持有 12 天均值要大于持有 8 天。
  const trades: ClosedTrade[] = [
    { id: "a", entryDate: "2026-10-01", entry: 10, stop: 9.2, target: 12.5 },
    { id: "a", entryDate: "2026-10-05", entry: 10, stop: 9.2, target: 12.5 },
  ];
  const map = { a: upBars("2026-10-01", 40) };
  const run8 = await simulateMean(trades, barsMapOf(map), { holdDays: 8, stopPct: null, targetPct: null });
  const run12 = await simulateMean(trades, barsMapOf(map), { holdDays: 12, stopPct: null, targetPct: null });
  assert.equal(run8.simulated, 2);
  assert.equal(run8.skipped, 0);
  assert.ok(run8.mean != null && run12.mean != null && run12.mean > run8.mean);
});

test("simulateMean：K 线取不到 / 建仓日不在窗口内 → 记 skipped 不进均值", async () => {
  const trades: ClosedTrade[] = [
    { id: "a", entryDate: "2026-10-01", entry: 10, stop: 9, target: 12 },
    { id: "ghost", entryDate: "2026-10-01", entry: 10, stop: 9, target: 12 },
    { id: "a", entryDate: "2020-01-01", entry: 10, stop: 9, target: 12 }, // 远早于窗口
  ];
  const run = await simulateMean(trades, barsMapOf({ a: flatBars("2026-10-01", 30) }), { holdDays: 5, stopPct: 10, targetPct: 20 });
  assert.equal(run.simulated, 1);
  assert.equal(run.skipped, 2);
  assert.ok(run.mean != null);
});

test("simulateMean：一笔都模拟不出来 → mean 为 null", async () => {
  const run = await simulateMean([], async () => null, { holdDays: 5, stopPct: 10, targetPct: 20 });
  assert.equal(run.mean, null);
  assert.equal(run.simulated, 0);
});

// ── robustnessReport ───────────────────────────────────────────

const chalOf = (over: Partial<Pick<import("@/lib/market/challenger").Challenger, "holdDays" | "stopPct" | "targetPct">>) => ({
  id: "c_vt3",
  style: "breakout",
  name: "VT3 测试",
  status: "promoted" as const,
  since: "2026-10-01",
  ...over,
});

test("robustnessReport：样本不足 minTrades 返回 null，不硬凑", async () => {
  const report = await robustnessReport({
    chal: chalOf({ holdDays: 10, stopPct: 10, targetPct: 25 }),
    verdict: "promote",
    trades: [{ id: "a", entryDate: "2026-10-01", entry: 10, stop: 9, target: 12 }],
    barsOf: barsMapOf({}),
  });
  assert.equal(report, null);
});

test("robustnessReport：邻域一赚一崩 → fragile=true（悬崖），报告带 simulated/skipped", async () => {
  // 涨 9 天再温和回调的行情里，持有天数是唯一敏感维度：持有 8 天 +8% 逃顶，
  // 持有 12 天吃进回调 −4% 起。邻域一正一负、CV 超 1 → 判「悬崖」。
  const trades: ClosedTrade[] = Array.from({ length: 6 }, () => ({
    id: "a",
    entryDate: "2026-09-01",
    entry: 10,
    stop: 9,
    target: 30, // 很高的目标，行情打不到，出场全看持有天数
  }));
  const map = { a: boomThenCrash("2026-09-01", 60) };
  const report = await robustnessReport({
    chal: chalOf({ holdDays: 10, stopPct: undefined, targetPct: undefined }),
    verdict: "promote",
    trades,
    barsOf: barsMapOf(map),
  });
  assert.ok(report);
  assert.equal(report.id, "c_vt3");
  assert.equal(report.verdict, "promote");
  assert.equal(report.fragile, true);
  assert.equal(report.simulated, 6);
  assert.equal(report.skipped, 0);
  assert.match(report.note, /悬崖/);
  assert.ok(report.baseMean != null);
  assert.ok(report.neighbors.length > 0);
});

test("robustnessReport：邻域全模拟不出来 → fragile=null 不下结论", async () => {
  const trades: ClosedTrade[] = Array.from({ length: 6 }, (_, i) => ({
    id: "a",
    entryDate: `2026-09-${String(10 + i).padStart(2, "0")}`,
    entry: 10,
    stop: 9,
    target: 12,
  }));
  // K 线只有 3 根：建仓日之后走不满任何持有期，全部 skipped。
  const report = await robustnessReport({
    chal: chalOf({ holdDays: 10, stopPct: 10, targetPct: 25 }),
    verdict: "reject",
    trades,
    barsOf: barsMapOf({ a: flatBars("2026-09-01", 3) }),
  });
  assert.ok(report);
  assert.equal(report.fragile, null);
  assert.equal(report.simulated, 0);
  assert.match(report.note, /不/);
});
