/**
 * 这个文件是干什么的：
 * 钉住事件研究的三条纪律——**少于 8 次不给平均、停牌不进平均、不预测这一次**。
 *
 * 「停牌不进平均」这条最容易实现错：复牌那天涨跌被算进窗口，会把平均带偏。
 * 测试用「窗口内挖掉一天」来模拟停牌，验证那次事件被排除在平均外。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EVENT_MIN, EVENT_POST, EVENT_PRE, studyEvents, type StudyEvent } from "@/lib/market/event-study";
import type { KlineRow } from "@/lib/market/indicators";

/** 造 n 天序列，价格 = 100 + i（每天 +1% 左右，具体看 close 递增值）。 */
function series(n: number, start = 100, step = 1, from = "2026-01-05"): KlineRow[] {
  const d0 = new Date(from);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(d0.getTime() + i * 86400_000);
    const c = start + i * step;
    return { date: d.toISOString().slice(0, 10), open: c, high: c + 1, low: c - 1, close: c };
  });
}

const LONG = series(300);

test("事件窗口：超额 = 个股涨跌 − 指数涨跌，逐日累加", () => {
  // 个股每天 +2，指数每天 +1 → 每日超额约 +1%，d0_1 约 +2%
  const events: StudyEvent[] = [{ date: LONG[100]!.date, label: "测试事件" }];
  const r = studyEvents(events, series(300, 100, 2), LONG);
  const w = r.windows[0]!;
  assert.equal(w.skip, undefined);
  assert.ok(w.d0_1 != null && w.d0_1 > 0, "个股涨得快，超额应为正");
  assert.ok(w.pre != null, "事件前 5 日也该有值");
});

test("个股与指数同步 → 超额接近 0", () => {
  const events: StudyEvent[] = [{ date: LONG[100]!.date, label: "同步" }];
  const r = studyEvents(events, LONG, LONG);
  assert.ok(Math.abs(r.windows[0]!.d0_20 as number) < 1e-9);
});

test("少于 8 次 → 只列逐次，不给平均", () => {
  const events: StudyEvent[] = Array.from({ length: EVENT_MIN - 1 }, (_, i) => ({ date: LONG[50 + i * 10]!.date, label: `事件${i}` }));
  const r = studyEvents(events, LONG, LONG);
  assert.equal(r.summary, null, "不足 8 次不许给平均");
  assert.equal(r.listed, EVENT_MIN - 1, "逐次结果照列");
  assert.ok(r.gaps.some((g) => g.includes("少于")), "要说明为什么没平均");
});

test("满 8 次 → 给平均（含 n 和胜率）", () => {
  const events: StudyEvent[] = Array.from({ length: EVENT_MIN }, (_, i) => ({ date: LONG[50 + i * 10]!.date, label: `事件${i}` }));
  const r = studyEvents(events, LONG, LONG);
  assert.ok(r.summary != null);
  assert.equal(r.summary!.n, EVENT_MIN);
  assert.ok(r.summary!.positiveShare != null);
});

test("停牌日不进平均（窗口内个股缺价）", () => {
  // 12 次事件；其中一次所在窗口挖掉一天 → 该次 haltedDays>0 → 不进平均
  const stock = series(300, 100, 2).map((r, i) => (i >= 96 && i <= 96 ? { ...r, close: NaN as unknown as number } : r));
  // 上面造 NaN 不行——直接删掉那一天来模拟停牌
  const stockWithHalt = series(300, 100, 2).filter((_, i) => i !== 97);
  const events: StudyEvent[] = Array.from({ length: EVENT_MIN + 4 }, (_, i) => ({ date: LONG[50 + i * 10]!.date, label: `事件${i}` }));
  const r = studyEvents(events, stockWithHalt, LONG);
  const halted = r.windows.filter((w) => w.haltedDays > 0);
  assert.ok(halted.length >= 1, "至少要有一次的窗口覆盖被挖掉的那天");
  const cleanCount = r.windows.filter((w) => !w.skip && w.haltedDays === 0).length;
  assert.equal(r.summary!.n, cleanCount, "平均只用无停牌的");
});

test("事件前数据不够 → 记 skip 和缺口，不静默丢", () => {
  // 事件日早于数据起始 → 前窗不够（这比「事件后没有交易日」更准）
  const events: StudyEvent[] = [{ date: "2020-01-05", label: "太早" }];
  const r = studyEvents(events, series(100, 100, 1, "2026-01-05"), series(100, 100, 1, "2026-01-05"));
  assert.match(r.windows[0]!.skip!, /事件前不够/);
  assert.ok(r.gaps.length > 0);
});

test("事件晚于所有数据 → 记 skip 和缺口", () => {
  const events: StudyEvent[] = [{ date: "2030-01-05", label: "太晚" }];
  const r = studyEvents(events, series(100, 100, 1, "2026-01-05"), series(100, 100, 1, "2026-01-05"));
  assert.match(r.windows[0]!.skip!, /事件之后/);
  assert.ok(r.gaps.length > 0);
});

test("PRE/POST 常量与它一致", () => {
  assert.equal(EVENT_PRE, 5);
  assert.equal(EVENT_POST, 20);
  assert.equal(EVENT_MIN, 8);
});

test("路径数组从事件前第 5 日起（画图用）", () => {
  const events: StudyEvent[] = [{ date: LONG[100]!.date, label: "路径" }];
  const r = studyEvents(events, series(300, 100, 2), LONG);
  const w = r.windows[0]!;
  // 窗口 = 前 5 日 + 当天起 + 后 20 日 ≈ 26~27 个点
  assert.ok(w.path.length >= EVENT_PRE + EVENT_POST, `路径长度 ${w.path.length}`);
});

test("只描述过去，不预测——输出里没有预测性措辞", () => {
  const events: StudyEvent[] = [{ date: LONG[100]!.date, label: "措辞" }];
  const json = JSON.stringify(studyEvents(events, series(300, 100, 2), LONG));
  assert.ok(!/(预计|将会|大概率|建议|应该)/.test(json), "不许有预测和动作措辞");
});
