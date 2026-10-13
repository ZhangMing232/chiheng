/**
 * 这个文件是干什么的：
 * 钉住板块页视图层的规矩。
 *
 * 重点：
 * 1. 缺月度数据的板块照样列出，列留 null（不填 0）
 * 2. 排序时缺值沉底，不混进「跌得最惨」那一头
 * 3. 分类/月度两件事分开报缺口，不合并成一句「行业数据缺失」
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { boardDetail, boardTable, searchBoards, sortBoards, type MonthlyBook } from "@/lib/market/sectors-view";
import { buildIndustryIndex, type IndustryIndex } from "@/lib/market/industry";
import { monthlyFromBars, type BoardDaily } from "@/lib/market/industry-monthly";

function index(): IndustryIndex {
  return buildIndustryIndex(
    [
      { code: "BK1", name: "印制电路板", members: ["sh1", "sh2", "sh3"] },
      { code: "BK2", name: "白酒Ⅲ", members: ["sh4"] },
      { code: "BK3", name: "铜", members: ["sh5", "sh6"] },
    ],
    "2026-10-13",
  );
}

function bars(month: string, from: number, to: number): BoardDaily[] {
  const out: BoardDaily[] = [];
  const step = (to - from) / 19;
  for (let d = 1; d <= 20; d += 1) {
    const price = from + step * (d - 1);
    out.push({ date: `${month}-${String(d).padStart(2, "0")}`, open: price, close: price, high: price, low: price, amount: 1e8, turnover: 2 });
  }
  return out;
}

function monthly(): MonthlyBook {
  const all = [...bars("2026-05", 100, 100), ...bars("2026-06", 100, 90), ...bars("2026-07", 90, 80), ...bars("2026-08", 80, 70)];
  const flow = ["2026-06", "2026-07", "2026-08"].map((m) => ({ date: `${m}-05`, mainNet: -1e8 }));
  const { months } = monthlyFromBars(all, flow, "2026-09-15");
  // BK3 故意不给数据
  return { updatedAt: "2026-10-13", boards: { BK1: { name: "印制电路板", months }, BK2: { name: "白酒Ⅲ", months } } };
}

test("分类没抓过：列表空且只报分类缺口", () => {
  const t = boardTable(null, monthly());
  assert.equal(t.rows.length, 0);
  assert.equal(t.gaps.length, 1);
  assert.match(t.gaps[0]!, /行业分类没抓过/);
});

test("月度没抓过：板块照样列出，月度列留 null", () => {
  const t = boardTable(index(), { updatedAt: "2026-10-13", boards: {} });
  assert.equal(t.rows.length, 3, "分类还在就能列");
  assert.ok(t.rows.every((r) => r.chgPct == null && r.mainNet == null));
  assert.ok(t.gaps.some((g) => g.includes("月度数据没抓过")));
});

test("缺月度数据的板块不填 0，方向是不明", () => {
  const t = boardTable(index(), monthly());
  const copper = t.rows.find((r) => r.code === "BK3")!;
  assert.equal(copper.members, 2);
  assert.equal(copper.chgPct, null, "null 不是 0");
  assert.equal(copper.direction, "不明");
});

test("方向依据跟着行一起给：当月和近三月可以相反，读者要看得见为什么", () => {
  // 白银 2026-09 单月跌了近两成，但近三个月整体仍是资金净流入为主 → 升温。
  // 两列并排却不给依据，读者只会以为页面自相矛盾
  const t = boardTable(index(), monthly());
  const pcb = t.rows.find((r) => r.code === "BK1")!;
  assert.match(pcb.basis, /3 个完整月/);
  assert.match(pcb.basis, /主力净流入月|资金流缺失/);
});

test("有数据的板块给出最新完整月和方向", () => {
  const t = boardTable(index(), monthly());
  const pcb = t.rows.find((r) => r.code === "BK1")!;
  assert.ok(pcb.chgPct != null && pcb.chgPct < 0, "连跌三个月");
  assert.equal(pcb.direction, "降温");
  assert.equal(pcb.latestMonth, "2026-08");
});

test("排序：缺值永远沉底，不混进跌得最惨那一头", () => {
  const t = boardTable(index(), monthly());
  const byChg = sortBoards(t.rows, "chg", false);
  assert.equal(byChg[byChg.length - 1]!.code, "BK3", "没数据的沉底");
  const byChgDesc = sortBoards(t.rows, "chg", true);
  assert.equal(byChgDesc[byChgDesc.length - 1]!.code, "BK3", "倒序也沉底");
});

test("按成员数/名字排序不丢行", () => {
  const t = boardTable(index(), monthly());
  assert.equal(sortBoards(t.rows, "members", true).length, 3);
  // 按拼音：bai < tong < yin
  assert.deepEqual(sortBoards(t.rows, "name", false).map((r) => r.name), ["白酒Ⅲ", "铜", "印制电路板"]);
});

test("搜索按名字或板块代码", () => {
  const t = boardTable(index(), monthly());
  assert.equal(searchBoards(t.rows, "印制").length, 1);
  assert.equal(searchBoards(t.rows, "bk2").length, 1, "代码不区分大小写");
  assert.equal(searchBoards(t.rows, "").length, 3);
  assert.equal(searchBoards(t.rows, "不存在的板块").length, 0);
});

test("板块详情：月度序列、方向读数、成分股", () => {
  const d = boardDetail(index(), monthly(), "BK1", 12)!;
  assert.equal(d.name, "印制电路板");
  assert.ok(d.months.length > 0);
  assert.equal(d.thermo.direction, "降温");
  assert.deepEqual(d.members, ["sh1", "sh2", "sh3"]);
  assert.equal(d.gaps.length, 0);
});

test("板块详情：没有月度数据时说清是月度缺，不是板块不存在", () => {
  const d = boardDetail(index(), monthly(), "BK3", 12)!;
  assert.equal(d.name, "铜", "分类里有，名字给得出");
  assert.equal(d.months.length, 0);
  assert.ok(d.gaps.some((g) => g.includes("月度数据没抓过")));
});

test("板块详情：压根没有这个板块返回 null", () => {
  assert.equal(boardDetail(index(), monthly(), "BK999", 12), null);
});

test("月度窗口只取最近 n 个月", () => {
  const d = boardDetail(index(), monthly(), "BK1", 2)!;
  assert.equal(d.months.length, 2);
  assert.equal(d.months[d.months.length - 1]!.month, "2026-08");
});
