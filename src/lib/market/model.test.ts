/**
 * 这个文件是干什么的：
 * 守住涨跌停幅度按板块区分这件事。
 *
 * 你需要知道的：
 * 代码分段决定了涨跌停，不是行情里的涨跌幅。sh689 是科创板存托凭证，
 * 曾经漏在 20% 的判断之外，会被当成主板按 10% 算，这里把它钉住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { boardLimit } from "@/lib/market/model";

test("主板 10%，创业板和科创板 20%，北证 30%", () => {
  assert.equal(boardLimit("sh600519", "贵州茅台"), 10);
  assert.equal(boardLimit("sz000001", "平安银行"), 10);
  assert.equal(boardLimit("sz300725", "药石科技"), 20);
  assert.equal(boardLimit("sz301001", "某某股"), 20);
  assert.equal(boardLimit("sh688356", "键凯科技"), 20);
  assert.equal(boardLimit("bj920000", "某某股"), 30);
});

test("科创板存托凭证 689 也按 20%，不能落回主板 10%", () => {
  assert.equal(boardLimit("sh689009", "九号公司"), 20);
});

test("ST 和带退的按 5%，优先于板块", () => {
  assert.equal(boardLimit("sh600001", "ST某某"), 5);
  assert.equal(boardLimit("sz300001", "某某退"), 5);
  assert.equal(boardLimit("sh688001", "ST某某"), 5);
});
