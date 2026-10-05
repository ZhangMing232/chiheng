/**
 * 这个文件是干什么的：
 * 守住持仓页那三个汇总数字：笔数、数量/金额、以及盈亏。
 *
 * 你需要知道的：
 * 口径上最容易错的是「金额」——这套模拟盘不记仓位大小，每笔按满仓记，
 * 所以金额只能是「每笔一手（100 股）折算的名义金额」。这个口径一旦含糊，
 * 页面上的数字会被当成真金白银。
 * 第二个易错点是浮动盈亏：只要有一天有一笔拿不到现价，这天的浮动就必须空着，
 * 不能只按能算的那几笔凑一个数——那会让人以为全平了。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dayHeading, groupByDay, overallOf, rowReturn, SHARES_PER_LOT, type PositionRow } from "@/lib/market/positions";

function row(patch: Partial<PositionRow> & { id: string; day: string; entry: number }): PositionRow {
  const exit = patch.exit ?? null;
  const live = patch.live ?? null;
  const ret = rowReturn(patch.entry, exit, live?.price ?? null);
  return {
    code: patch.id,
    name: patch.name ?? patch.id,
    exit,
    exitDate: exit == null ? null : (patch.exitDate ?? patch.day),
    signalTime: patch.signalTime ?? "09:41",
    live,
    state: exit == null ? "持有" : "已卖",
    ret,
    pnl: ret == null ? null : (exit ?? live?.price ?? patch.entry) - patch.entry,
    ...patch,
  } as PositionRow;
}

test("按建仓日分组，最近的一天在最前", () => {
  const groups = groupByDay([
    row({ id: "a", day: "2026-09-29", entry: 10 }),
    row({ id: "b", day: "2026-09-30", entry: 20 }),
    row({ id: "c", day: "2026-09-30", entry: 30 }),
  ]);
  assert.deepEqual(groups.map((g) => g.date), ["2026-09-30", "2026-09-29"]);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].count, 1);
});

test("数量按每笔一手折算，金额是名义金额", () => {
  const groups = groupByDay([
    row({ id: "a", day: "2026-09-30", entry: 10 }),
    row({ id: "b", day: "2026-09-30", entry: 20.5 }),
  ]);
  const g = groups[0];
  assert.equal(g.shares, 2 * SHARES_PER_LOT);
  // (10 + 20.5) × 100
  assert.equal(g.amount, 3050);
});

test("已实现和浮动分开，合计是两者相加", () => {
  const groups = groupByDay([
    row({ id: "a", day: "2026-09-30", entry: 10, exit: 11, exitDate: "2026-10-09" }),
    row({ id: "b", day: "2026-09-30", entry: 20, live: { price: 19, chg: -1 } }),
  ]);
  const g = groups[0];
  assert.equal(g.closed.length, 1);
  assert.equal(g.open.length, 1);
  const fee = 0.00025 * 2 + 0.0005 + 0.00001 * 2;
  assert.ok(Math.abs(g.realized! - (11 / 10 - 1 - fee)) < 1e-9);
  assert.ok(Math.abs(g.unrealized! - (19 / 20 - 1)) < 1e-9);
  assert.ok(Math.abs(g.total! - (g.realized! + g.unrealized!)) < 1e-12);
});

test("只要有一天有一笔拿不到现价，这天的浮动就是空着", () => {
  // 两笔持仓，其中一笔断网了——不能只按能算的那笔凑一个数
  const groups = groupByDay([
    row({ id: "a", day: "2026-09-30", entry: 10, live: { price: 11, chg: 2 } }),
    row({ id: "b", day: "2026-09-30", entry: 20, live: null }),
  ]);
  assert.equal(groups[0].unrealized, null);
  assert.equal(groups[0].openPnlAmount, null);
  // 已实现不受影响
  assert.equal(groups[0].realized, null); // 这天没卖出
  assert.equal(groups[0].total, null);
});

test("没有卖出的那天，已实现是空而不是 0", () => {
  const groups = groupByDay([row({ id: "a", day: "2026-09-30", entry: 10, live: { price: 10, chg: 0 } })]);
  assert.equal(groups[0].realized, null);
  assert.equal(groups[0].unrealized, 0);
});

test("合计行把所有天加起来", () => {
  const total = overallOf(
    groupByDay([
      row({ id: "a", day: "2026-09-29", entry: 10, exit: 11, exitDate: "2026-10-08" }),
      row({ id: "b", day: "2026-09-30", entry: 20, live: { price: 21, chg: 1 } }),
    ]),
  );
  assert.equal(total.count, 2);
  assert.equal(total.openCount, 1);
  assert.equal(total.closedCount, 1);
  assert.equal(total.shares, 200);
  assert.equal(total.amount, 3000);
});

test("日期标题", () => {
  assert.equal(dayHeading("2026-09-30", "周一"), "9月30日 周一");
  assert.equal(dayHeading("2026-09-30"), "9月30日");
  assert.equal(dayHeading("坏日期"), "坏日期");
});

test("收益率：卖出要扣费，持有按现价不算费", () => {
  const fee = 0.00025 * 2 + 0.0005 + 0.00001 * 2;
  assert.ok(Math.abs(rowReturn(10, 11, null)! - (0.1 - fee)) < 1e-9);
  // 浮点：9/10-1 在二进制里是 -0.09999999999999998，不能用严格相等
  assert.ok(Math.abs(rowReturn(10, null, 9)! + 0.1) < 1e-9);
  assert.equal(rowReturn(10, null, null), null);
  assert.equal(rowReturn(0, 11, null), null);
});
