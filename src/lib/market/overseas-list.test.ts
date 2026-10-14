/**
 * 这个文件是干什么的：
 * 钉住港美行情列表的解析与排序规矩。
 *
 * 重点：
 * 1. **fltt=2 时 f2/f3 已是原值**，不能再乘除 100（港股 1.75 / +12.9% 实测就是原值）
 * 2. **港股成交额常给 "-"** → null，不是 0；排序时缺值沉底，不冒充成交额高的票
 * 3. **认不出的代码跳过并计数**，不让一行脏数据毁掉整页
 * 4. 币种跟着市场走——港币和美元不是同一种钱，混着看不加标签会读错
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CURRENCY,
  filterOverseas,
  marketOfSecid,
  parseOverseasList,
  rowId,
  sortOverseas,
  type OverseasRow,
} from "@/lib/market/overseas-list";

const diff = (rows: unknown[]) => ({ data: { total: rows.length, diff: rows } });

const hkRow = (over: Record<string, unknown> = {}) => ({
  f12: "00700",
  f13: 116,
  f14: "腾讯控股",
  f2: 425.8,
  f3: 1.25,
  f4: 5.25,
  f6: 1234567890,
  ...over,
});

const usRow = (over: Record<string, unknown> = {}) => ({
  f12: "NVDA",
  f13: 105,
  f14: "英伟达",
  f2: 180.5,
  f3: -0.62,
  f4: -1.12,
  f6: 98765432100,
  ...over,
});

test("市场号：116 是港股，105/106/107 是美股三个交易所", () => {
  assert.equal(marketOfSecid(116), "hk");
  assert.equal(marketOfSecid(105), "us");
  assert.equal(marketOfSecid(106), "us");
  assert.equal(marketOfSecid(107), "us");
  assert.equal(marketOfSecid(1), null, "A 股不该走到这里");
});

test("内部 id：港股五位补 hk，美股字母补 us；认不出来返回 null", () => {
  assert.equal(rowId("00700", 116), "hk00700");
  assert.equal(rowId("NVDA", 105), "usNVDA");
  assert.equal(rowId("BRK-B", 106), "usBRK-B", "带横杠的美股代码要认");
  assert.equal(rowId("700", 116), null, "港股必须是五位");
  assert.equal(rowId("70000", 1), null, "不认识的市场号不造 id");
});

test("解析：价格和涨跌幅是原值，不乘除 100", () => {
  const { rows } = parseOverseasList(diff([hkRow()]));
  assert.equal(rows[0]!.price, 425.8);
  assert.equal(rows[0]!.chg, 1.25);
  assert.equal(rows[0]!.currency, "HKD");
});

test("解析：港股成交额 '-' 是 null，不是 0", () => {
  const { rows } = parseOverseasList(diff([hkRow({ f6: "-" }), usRow()]));
  assert.equal(rows[0]!.amount, null);
  assert.equal(rows[1]!.amount, 98765432100);
});

test("解析：坏行跳过并计数，不让一行脏数据毁掉整页", () => {
  const { rows, bad } = parseOverseasList(
    diff([hkRow(), { f12: "123", f13: 999, f14: "怪东西" }, { f13: 116 }, hkRow({ f12: "09988" })]),
  );
  assert.equal(rows.length, 2);
  assert.equal(bad, 2);
});

test("解析：返回体不对时给空表而不是崩", () => {
  assert.deepEqual(parseOverseasList(null), { rows: [], bad: 0, total: 0 });
  assert.deepEqual(parseOverseasList({ data: null }), { rows: [], bad: 0, total: 0 });
});

test("解析：diff 是对象形式（东财有时这么返）也能读", () => {
  const { rows } = parseOverseasList({ data: { total: 1, diff: { 0: hkRow() } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "腾讯控股");
});

test("排序：缺值沉底，不冒充成交额最高的票", () => {
  const rows = parseOverseasList(diff([hkRow({ f6: "-" }), usRow(), hkRow({ f12: "09988", f6: 5 })])).rows;
  const sorted = sortOverseas(rows, "amount", true);
  assert.equal(sorted[0]!.id, "usNVDA");
  assert.equal(sorted[sorted.length - 1]!.id, "hk00700", "没成交额的沉底");
});

test("排序：涨跌幅升序时负的在前", () => {
  const rows = parseOverseasList(diff([hkRow(), usRow(), hkRow({ f12: "09988", f3: -5 })])).rows;
  assert.equal(sortOverseas(rows, "chg", false)[0]!.code, "09988");
});

test("按代码或名称过滤当前页，空串全要", () => {
  const rows = parseOverseasList(diff([hkRow(), usRow()])).rows;
  assert.equal(filterOverseas(rows, "腾讯").length, 1);
  assert.equal(filterOverseas(rows, "nvda").length, 1, "代码不分大小写");
  assert.equal(filterOverseas(rows, "").length, 2);
  assert.equal(filterOverseas(rows, "没有这只").length, 0);
});

test("币种跟着市场走，港币和美元不混", () => {
  assert.equal(CURRENCY.hk, "HKD");
  assert.equal(CURRENCY.us, "USD");
  const rows = parseOverseasList(diff([hkRow(), usRow()])).rows;
  assert.deepEqual(rows.map((r) => r.currency), ["HKD", "USD"]);
});