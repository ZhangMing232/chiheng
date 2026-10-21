/**
 * 钉死路由 search 参数校验的数字吞参回归——
 * 2026-10-21 实测：?q=600519 被路由器 JSON 解析成 number，只认 string 的校验把它吃掉，
 * 307 清回 ?q=，多空辩论/个股研判输入数字代码「没反应」；?batch=5 同理被清回 -1。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBatch, qParam } from "@/lib/search-params";

test("qParam：string 原样收、截断、去空白", () => {
  assert.equal(qParam({ q: "600519" }), "600519");
  assert.equal(qParam({ q: "  贵州茅台  " }), "贵州茅台");
  assert.equal(qParam({ q: "x".repeat(30) }), "x".repeat(20));
});

test("qParam：number 转字符串（JSON 数字吞参回归）", () => {
  assert.equal(qParam({ q: 600519 }), "600519");
  assert.equal(qParam({ q: 1 }), "1");
});

test("qParam：缺参/非法类型归空串", () => {
  assert.equal(qParam({}), "");
  assert.equal(qParam({ q: null }), "");
  assert.equal(qParam({ q: ["600519"] }), "");
  assert.equal(qParam({ q: true }), "");
  assert.equal(qParam({ q: Number.NaN }), "");
});

test("parseBatch：string 数字收，缺省/非法归 -1", () => {
  assert.equal(parseBatch({ batch: "5" }), 5);
  assert.equal(parseBatch({ batch: "0" }), 0);
  assert.equal(parseBatch({}), -1);
  assert.equal(parseBatch({ batch: "abc" }), -1);
  assert.equal(parseBatch({ batch: "1.5" }), -1);
});

test("parseBatch：number 收（JSON 数字吞参回归），负数/超大值有界", () => {
  assert.equal(parseBatch({ batch: 5 }), 5);
  assert.equal(parseBatch({ batch: 0 }), 0);
  assert.equal(parseBatch({ batch: -1 }), -1);
  assert.equal(parseBatch({ batch: 1.5 }), -1);
  assert.equal(parseBatch({ batch: 99999 }), 9999);
});
