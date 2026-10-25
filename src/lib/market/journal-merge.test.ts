/**
 * 这个文件是干什么的：
 * 钉死 journal-merge.ts 的合并规则。这套规则是对着「两本账分叉」这个真实
 * 病灶立的（2026-10-25 用户要求对齐），每一条都对应一种分叉场景。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBooks, previewMerge, tradeKey, type MergeStats } from "@/lib/market/journal-merge";
import type { PaperDay, PaperTrade } from "@/lib/paper";

// 注意：style 不加默认值——传 undefined 也要真的是 undefined（默认参数会把
// undefined 替换成 "early"，「无 style 旧账」的用例就永远造不出来）。
const trade = (id: string, entry: number, style?: PaperTrade["style"]): PaperTrade => ({
  id,
  code: id.replace(/[a-z]/g, "").padStart(6, "0"),
  name: `票${id}`,
  entry,
  style,
  exit: null,
  exitDate: null,
});

const day = (date: string, trades: PaperTrade[], extra: Partial<PaperDay> = {}): PaperDay => ({
  date,
  savedAt: 1000,
  signalTime: "09:30",
  indexEntry: 4000,
  indexExit: null,
  trades,
  ...extra,
});

const emptyStats = (): MergeStats => ({ addedDays: 0, addedTrades: 0, duplicatedTrades: 0, stylessTrades: 0, invalidDays: 0 });

test("服务端没有的天：整本加入", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-21", [trade("sh600002", 20, "early")])];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days.length, 2);
  assert.deepEqual(stats, { ...emptyStats(), addedDays: 1 });
  // 输出按日期降序
  assert.equal(days[0].date, "2026-10-21");
});

test("🔴 同一天同一笔两边都有：保留服务端，不用浏览器覆盖", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-20", [{ ...trade("sh600001", 99, "early"), name: "浏览器写的名字" }])];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days.length, 1);
  assert.equal(days[0].trades.length, 1);
  assert.equal(days[0].trades[0].entry, 10, "服务端的买入价才是正账");
  assert.equal(days[0].trades[0].name, "票sh600001", "浏览器侧的同键 trade 整条丢弃");
  assert.deepEqual(stats, { ...emptyStats(), duplicatedTrades: 1 });
});

test("同一天：浏览器独有的笔补进去", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-20", [trade("sh600001", 10, "early"), trade("sh600002", 20, "early")])];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days[0].trades.length, 2);
  assert.deepEqual(stats, { ...emptyStats(), addedTrades: 1, duplicatedTrades: 1 });
});

test("同 id 不同 style 是两笔（键含 style）", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-20", [trade("sh600001", 10, "trend")])];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days[0].trades.length, 2);
  assert.deepEqual(stats, { ...emptyStats(), addedTrades: 1 });
});

test("没有 style 的旧账 trade：不合并不统计（recordDay 同款取舍）", () => {
  const server = [day("2026-10-20", [])];
  const browser = [day("2026-10-20", [trade("sh600001", 10, undefined)])];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days[0].trades.length, 0, "无 style 的孤儿不合并——宁可少合也不重");
  assert.deepEqual(stats, { ...emptyStats(), stylessTrades: 1 });
});

test("字段兜底：服务端优先，index 只在服务端 null 时用浏览器的", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")], { signalTime: "09:31", indexEntry: 4100, savedAt: 5000 })];
  const browser = [day("2026-10-20", [], { signalTime: "14:00", indexEntry: 4200, indexExit: 4150, savedAt: 9000 })];
  const { days } = mergeBooks(server, browser);
  assert.equal(days[0].signalTime, "09:31", "服务端有的字段不用浏览器盖");
  assert.equal(days[0].indexEntry, 4100, "同上");
  assert.equal(days[0].indexExit, 4150, "服务端为 null 的才兜底");
  assert.equal(days[0].savedAt, 9000, "savedAt 取较新");
});

test("结构坏的浏览器账天数：跳过并计数，不拖垮整批", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [
    null as unknown as PaperDay,
    { date: "2026-10-21" } as unknown as PaperDay, // 缺 trades
    day("2026-10-22", [trade("sh600002", 20, "early")]),
  ];
  const { days, stats } = mergeBooks(server, browser);
  assert.equal(days.length, 2, "好的照旧合并");
  assert.deepEqual(stats, { ...emptyStats(), addedDays: 1, invalidDays: 2 });
});

test("不改入参", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-21", [trade("sh600002", 20, "early")])];
  const serverSnapshot = JSON.stringify(server);
  const browserSnapshot = JSON.stringify(browser);
  mergeBooks(server, browser);
  assert.equal(JSON.stringify(server), serverSnapshot);
  assert.equal(JSON.stringify(browser), browserSnapshot);
});

test("幂等：合并两次等于合并一次", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-21", [trade("sh600002", 20, "early")]), day("2026-10-20", [trade("sh600001", 10, "early")])];
  const once = mergeBooks(server, browser);
  const twice = mergeBooks(once.days, browser);
  assert.equal(JSON.stringify(twice.days), JSON.stringify(once.days), "第二遍全是 duplicated，账本不动");
  assert.equal(twice.stats.duplicatedTrades, 2);
  assert.equal(twice.stats.addedTrades, 0);
});

test("previewMerge 和 mergeBooks 统计一致（确认弹窗显示的数字就是会发生的事）", () => {
  const server = [day("2026-10-20", [trade("sh600001", 10, "early")])];
  const browser = [day("2026-10-20", [trade("sh600001", 10, "early"), trade("sh600002", 20, "early")]), day("2026-10-21", [])];
  assert.deepEqual(previewMerge(server, browser), mergeBooks(server, browser).stats);
});

test("tradeKey：有 style 才建键", () => {
  assert.equal(tradeKey(trade("sh600001", 10, "early")), "early:sh600001");
  assert.equal(tradeKey(trade("sh600001", 10)), null);
});
