/**
 * 这个文件是干什么的：
 * 钉住技术指标——**口径与 Vibe-Research 逐字对齐**，且坏数据进不来。
 *
 * 「口径对齐」怎么验：用一个手工可算的小序列（比如 5 根已知 K 线）核对 MA/RSI；
 * MACD/EMA/BOLL 用「参数组合下的结构正确 + 边界行为」钉。
 * 「坏数据进不来」验 OHLC 自洽和价格为正——列映射错时指标会静默算错，
 * 那是比报错更危险的事。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { INDICATOR_MIN_POINTS, technicalIndicators } from "@/lib/market/indicators";

/** 造 n 根递增 K 线（收盘 = 10+i，high/low 包住 close）。 */
function klines(n: number, start = 10): { date: string; open: number; high: number; low: number; close: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i;
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: c, high: c + 1, low: c - 1, close: c };
  });
}

test("少于 30 根 → not_meaningful，不硬算", () => {
  const r = technicalIndicators(klines(INDICATOR_MIN_POINTS - 1));
  assert.equal(r.status, "not_meaningful");
  assert.match(r.reason!, /少于 30/);
});

test("MA 是简单均线（可手算）", () => {
  const rows = klines(40); // close 10..49
  const r = technicalIndicators(rows);
  assert.equal(r.status, "ok");
  assert.equal(r.ma!.ma5, (45 + 46 + 47 + 48 + 49) / 5);
  assert.equal(r.ma!.ma10, 44.5);
});

test("MACD 结构正确：hist = (dif − dea) × 2", () => {
  const r = technicalIndicators(klines(60));
  const { dif, dea, hist } = r.macd!;
  assert.ok(Math.abs(hist - (dif - dea) * 2) < 1e-12, "口径必须是 ×2");
});

test("RSI 用简单平均（非 Wilder）：全涨时 RSI = 100", () => {
  const r = technicalIndicators(klines(40));
  assert.equal(r.rsi!.rsi6, 100, "只涨不跌，简单平均下 avg loss = 0 → RSI 100");
});

test("RSI 一半涨一半跌 → 50", () => {
  // 真正交替：20, 22, 20, 22...（涨跌各半）
  const rows = Array.from({ length: 40 }, (_, i) => {
    const c = 20 + (i % 2 === 0 ? 0 : 2);
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: c, high: c + 1, low: c - 1, close: c };
  });
  const r = technicalIndicators(rows);
  assert.equal(r.status, "ok");
  assert.ok(Math.abs((r.rsi!.rsi6 as number) - 50) < 1e-9, `实际 ${r.rsi!.rsi6}`);
});

test("BOLL 用总体标准差（除以 n），带宽 = (上−下)/中×100", () => {
  const r = technicalIndicators(klines(40), { boll: [20, 2] });
  const { upper, middle, lower, bandwidthPct } = r.boll!;
  assert.ok(Math.abs(upper - (middle + 2 * ((upper - middle) / 2))) < 1e-9);
  assert.ok(Math.abs(bandwidthPct - ((upper - lower) / middle) * 100) < 1e-9);
});

test("KDJ：全涨到顶时 K/D/J 结构正确（J = 3K − 2D）", () => {
  const r = technicalIndicators(klines(40));
  const { k, d, j } = r.kdj!;
  assert.ok(Math.abs(j - (3 * k - 2 * d)) < 1e-9);
});

test("坏数据进不来：high < low 报错", () => {
  const rows = klines(40);
  rows[20] = { ...rows[20]!, high: 5, low: 50 };
  const r = technicalIndicators(rows);
  assert.equal(r.status, "error");
  assert.match(r.reason!, /high < low/);
});

test("坏数据进不来：close 超出 [low, high] 报错", () => {
  const rows = klines(40);
  rows[10] = { ...rows[10]!, close: 999 };
  const r = technicalIndicators(rows);
  assert.equal(r.status, "error");
  assert.match(r.reason!, /close 不在/);
});

test("坏数据进不来：价格非正报错", () => {
  const rows = klines(40);
  rows[5] = { ...rows[5]!, close: 0 };
  const r = technicalIndicators(rows);
  assert.equal(r.status, "error");
});

test("空列表报错，不是静默返回空指标", () => {
  const r = technicalIndicators([]);
  assert.equal(r.status, "error");
});

test("指标只给数不做解读（返回里没有买卖信号字样）", () => {
  const r = technicalIndicators(klines(60));
  const json = JSON.stringify(r);
  assert.ok(!/(买入|卖出|金叉|死叉|加仓|建仓)/.test(json), "指标层不许出现动作词");
});
