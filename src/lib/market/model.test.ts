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
import { BOARD_LABEL, boardLimit, boardOf } from "@/lib/market/model";

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


/**
 * 下面这两条钉的是 2026-10-14 修的那个真 bug：三处各写一份 boardOf，
 * 其中一份不认科创/创业。个股抽屉里 sh688 显示「沪市」、sz300 显示「深市」，
 * 而同一页的涨跌停按 20% 算——页面自己跟自己矛盾。
 */

/** 板块标签和涨跌停口径必须一致：20% 的板不能显示成主板。 */
test("boardOf 与 boardLimit 口径一致：20% 的板不能被标成沪市/深市", () => {
  for (const id of ["sh688356", "sh689009", "sz300725", "sz301001"]) {
    assert.equal(boardLimit(id, "某某"), 20, `${id} 的涨跌停应是 20%`);
    const board = boardOf(id);
    assert.ok(board === "kcb" || board === "cyb", `${id} 板块应是科创或创业，实际 ${board}（${BOARD_LABEL[board]}）`);
  }
});

test("boardOf 认全七个板块，港美按前缀", () => {
  assert.equal(boardOf("sh600519"), "sh");
  assert.equal(boardOf("sz000001"), "sz");
  assert.equal(boardOf("sz301001"), "cyb");
  assert.equal(boardOf("sh688001"), "kcb");
  assert.equal(boardOf("bj920000"), "bj");
  assert.equal(boardOf("hk00700"), "hk");
  assert.equal(boardOf("usNVDA"), "us");
});

test("港美无涨跌停（markets.ts 的 limit: none）", () => {
  assert.equal(boardLimit("hk00700", "腾讯控股"), null);
  assert.equal(boardLimit("usNVDA", "英伟达"), null);
});
