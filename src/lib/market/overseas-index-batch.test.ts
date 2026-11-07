/**
 * 这个文件是干什么的：
 * 钉住港美指数「一次批量」的解析口径。原来逐个打 stock/get（6 次 + 限速 sleep），
 * 改成一次 ulist.np/get 后，必须证明数据没走样——尤其涨跌幅仍是自算、不是抄东财 f3。
 *
 * 下面的数字是 2026-11-07 真实抓到的收盘数据，用来对齐新旧两套字段：
 * 旧 f43/100 === 新 f2，旧 f60/100 === 新 f18。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { OVERSEAS_INDICES, parseOverseasIndexBatch } from "@/lib/market/overseas-index-batch";

const REAL = [
  { f12: "HSI", f13: 100, f14: "恒生指数", f2: 24481.86, f18: 24796.98, f3: -1.27 },
  { f12: "HSCEI", f13: 100, f14: "国企指数", f2: 8274.1, f18: 8369.08, f3: -1.13 },
  { f12: "HSTECH", f13: 124, f14: "恒生科技指数", f2: 4078.23, f18: 4154.29, f3: -1.83 },
  { f12: "DJIA", f13: 100, f14: "道琼斯", f2: 51285.73, f18: 51523.06, f3: -0.46 },
  { f12: "NDX", f13: 100, f14: "纳斯达克", f2: 24579.42, f18: 24315, f3: 1.09 },
  { f12: "SPX", f13: 100, f14: "标普500", f2: 7376.86, f18: 7353.73, f3: 0.31 },
];

const body = (rows: unknown[]) => ({ data: { diff: rows } });

test("6 个指数按 secid 一一对应，顺序不乱、名称取东财给的中文名", () => {
  const { quotes, gaps } = parseOverseasIndexBatch(body(REAL));
  assert.equal(quotes.length, 6);
  assert.deepEqual(gaps, []);
  assert.deepEqual(quotes.map((q) => q.secid), OVERSEAS_INDICES.map((i) => i.secid));
  assert.equal(quotes[2]!.name, "恒生科技指数");
  assert.equal(quotes[0]!.price, 24481.86);
});

test("涨跌幅用现价和昨收自算，不抄东财 f3（f3 只有 2 位小数）", () => {
  const tampered = REAL.map((r) => ({ ...r, f3: 999 }));
  const { quotes } = parseOverseasIndexBatch(body(tampered));
  assert.equal(quotes[0]!.chg, ((24481.86 - 24796.98) / 24796.98) * 100);
  assert.ok(Math.abs(quotes[0]!.chg! - (-1.2708)) < 0.001);
  assert.ok(Math.abs(quotes[4]!.chg! - 1.0875) < 0.001);
  assert.equal(quotes[0]!.chg, parseOverseasIndexBatch(body(REAL)).quotes[0]!.chg);
});

test("批量口径与旧逐只口径数值一致：f43/100===f2、f60/100===f18，比例不变", () => {
  // 旧代码：price = f43/100，chg = (f43-f60)/f60*100
  const oldF43 = 2448186;
  const oldF60 = 2479698;
  const oldChg = ((oldF43 - oldF60) / oldF60) * 100;
  const { quotes } = parseOverseasIndexBatch(body(REAL));
  assert.equal(oldF43 / 100, quotes[0]!.price);
  assert.equal(oldF60 / 100, 24796.98);
  assert.ok(Math.abs(oldChg - quotes[0]!.chg!) < 1e-10);
});

test("休市只给昨收：写清缺口，price 用昨收、chg 为 null，不编 0 点位", () => {
  const closed = REAL.map((r) => (r.f12 === "HSI" ? { ...r, f2: 0 } : r));
  const { quotes, gaps } = parseOverseasIndexBatch(body(closed));
  assert.equal(quotes[0]!.price, 24796.98);
  assert.equal(quotes[0]!.chg, null);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]!, /没有新价格/);
  assert.match(gaps[0]!, /昨收/);
  assert.equal(quotes[1]!.chg != null, true, "别的指数不受影响");
});

test("f2 是 '-'（东财休市的另一种给法）也按没新价格处理", () => {
  const dash = REAL.map((r) => (r.f12 === "NDX" ? { ...r, f2: "-" } : r));
  const { quotes, gaps } = parseOverseasIndexBatch(body(dash));
  assert.equal(quotes[4]!.price, 24315);
  assert.equal(quotes[4]!.chg, null);
  assert.equal(gaps.length, 1);
});

test("请求失败/超时（body=null）：6 个都如实写没拉到，不返回空数组、不编 0", () => {
  const { quotes, gaps } = parseOverseasIndexBatch(null);
  assert.equal(quotes.length, 6, "拿不到 ≠ 没有：仍要给出 6 行占位说明");
  assert.equal(gaps.length, 6);
  assert.ok(quotes.every((q) => q.price === null && q.chg === null));
  assert.ok(gaps.every((g) => g.includes("没拉到")));
});

test("恒生科技在 124 域：写成 100 域就认不出，不会被悄悄算成恒指", () => {
  const wrong = REAL.map((r) => (r.f12 === "HSTECH" ? { ...r, f13: 100 } : r));
  const { quotes, gaps } = parseOverseasIndexBatch(body(wrong));
  assert.equal(quotes[2]!.price, null);
  assert.equal(quotes[2]!.chg, null);
  assert.match(gaps[0]!, /124\.HSTECH/);
});

test("diff 是对象形式（东财偶尔这么给）也能解析", () => {
  const obj = Object.fromEntries(REAL.map((r, i) => [String(i), r]));
  const { quotes, gaps } = parseOverseasIndexBatch({ data: { diff: obj } });
  assert.equal(quotes.length, 6);
  assert.deepEqual(gaps, []);
  assert.equal(quotes[3]!.price, 51285.73);
});
