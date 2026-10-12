/**
 * 这个文件是干什么的：
 * 钉住估值分位的三件事——口径、边界、以及**方向不能反**。
 *
 * 方向那条最重要：亏损股的 PE 是空值，如果补成 0 参与计算，
 * 「历史上比现在便宜」的比例会变成 0%，页面会说它「史上最便宜」——
 * 正好把最危险的票说成最便宜的。这类错误比算错一位小数严重得多。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MIN_POINTS,
  percentileRank,
  rankPhrase,
  valuationPosition,
  loadValuationHistory,
  type ValuationHistory,
  type ValuationPoint,
} from "@/lib/market/pe-history";

function point(over: Partial<ValuationPoint> = {}): ValuationPoint {
  return { date: "2026-01-01", close: 10, peTTM: 20, pbMRQ: 2, psTTM: 3, turn: 1, isST: false, ...over };
}

function history(series: ValuationPoint[], over: Partial<ValuationHistory> = {}): ValuationHistory {
  return {
    code: "600519",
    symbol: "sh.600519",
    source: "baostock",
    adjust: "none",
    fetchedAt: "2026-10-12",
    window: { from: "2021-10-12", to: "2026-10-12" },
    counts: { raw: series.length, traded: series.length, halted: 0 },
    series,
    ...over,
  };
}

/** 造 n 个递增的点，值从 start 起每行 +1。 */
function rising(n: number, start = 1): ValuationPoint[] {
  return Array.from({ length: n }, (_, i) => point({ date: `2026-${i}`, peTTM: start + i }));
}

/**
 * 60 个递增点，值是 1..60。
 *
 * 样本数必须过 MIN_POINTS（60），少一个都会被拒 —— 那个 null
 * 是刻意的：点数不够时承认算不出来，比给一个看着合理的假数字强。
 */
function sample(): number[] {
  return Array.from({ length: MIN_POINTS }, (_, i) => i + 1);
}

test("分位口径：历史上有多少比例的日子比现在便宜", () => {
  // [1..60] 里比 31 便宜的是 1..30 共 30 个 → 50%
  assert.equal(percentileRank(sample(), 31), 50);
});

test("等于当前值不算便宜（严格小于），不是算一半", () => {
  // 当前值 31 自己也在样本里；若误用 <=，分子会变成 31 → 51.67%
  assert.equal(percentileRank(sample(), 31), 50);
});

test("样本不足就返回 null，不给 50 装作中间", () => {
  const few = rising(MIN_POINTS - 1).map((p) => p.peTTM!);
  assert.equal(percentileRank(few, 5), null, "点数不够时必须承认算不出来");
});

test("缺失值从样本里剔除，不补 0", () => {
  // 在 1..60 里插两个空值，有效样本仍是 60 个，比 31 便宜的还是 30 个 → 50%
  const withHoles: (number | null)[] = [null, ...sample(), null];
  assert.equal(percentileRank(withHoles, 31), 50, "空值被剔除而不是算作 0");
});

test("方向不能反：全是空值时返回 null，不许说成史上最便宜", () => {
  const allNull = [null, null, null];
  assert.equal(percentileRank(allNull, 0), null);
  // 哪怕是 0（看起来最便宜的值）也不许算出 0%
  assert.equal(percentileRank([], 0), null);
});

test("valuationPosition：有真实序列时给出 PE 与 PB 两个分位", () => {
  // 60 个递增点，最新点是最贵那个 → 应在最高分位附近但不等于 100（自身不小于自身）
  const series = rising(MIN_POINTS);
  const pos = valuationPosition(history(series))!;
  assert.ok(pos.latest != null);
  const rank = pos.peRank;
  assert.ok(rank != null && rank > 95, `递增序列的最后一个点应在高分位，实际 ${rank}`);
  assert.ok(pos.points >= MIN_POINTS);
});

test("最新点缺 PE 时 peRank 为 null，但 PB 照常给", () => {
  const series = [...rising(MIN_POINTS - 1), point({ date: "last", peTTM: null, pbMRQ: 5 })];
  const pos = valuationPosition(history(series))!;
  assert.equal(pos.peRank, null, "最新 PE 是空就不能给 PE 分位");
  assert.ok(pos.pbRank != null, "PB 有值就该给");
});

test("没有历史文件时说没有，不返回空序列冒充查过了", async () => {
  const got = await loadValuationHistory("000000", "/tmp/definitely-not-here-2026");
  assert.equal(got, null, "data 不在 git 里，换机器必然读不到 —— 这是预期不是错误");
});

test("rankPhrase 三档措辞，边界值落在哪边要说清", () => {
  assert.match(rankPhrase(95), /比过去绝大多数时候都贵/);
  assert.match(rankPhrase(5), /比过去绝大多数时候都便宜/);
  assert.match(rankPhrase(50), /历史 50 分位/);
  assert.equal(rankPhrase(null), "算不出历史位置", "算不出来就不能说得像算出来过");
});
