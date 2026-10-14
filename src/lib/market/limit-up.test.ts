/**
 * 这个文件是干什么的：
 * 钉住涨停三池的解析与统计口径。
 *
 * 重点（都是实测踩过的）：
 * 1. 价格是 ×1000 的整数（p: 6300 = 6.30 元）——它文档说"已 ÷1000"是它的封装做了
 * 2. 炸板池涨跌幅是**负的**（涨停后开板回落），不是 bug
 * 3. 连板数在炸板/跌停池是 null，显示"—"不是 0
 * 4. 炸板率的分母是"曾经涨停过的全部"（涨停+炸板），不是涨停池单独
 * 5. zttj 整个缺失时（跌停池实测 {}）stat 给 null，不编"0天0板"
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { breakRate, parsePool, rowIdOf, streakLadder, summarize, type LimitUpRow } from "@/lib/market/limit-up";

const upPayload = {
  data: {
    pool: [
      { c: "000530", n: "冰山冷热", p: 6300, zdp: 9.9476, lbc: 2, zbc: 0, fund: 367048974, hybk: "通用设备", zttj: { days: 2, ct: 2 } },
      { c: "000668", n: "荣丰控股", p: 22620, zdp: 10.0194, lbc: 2, zbc: 0, fund: 56237844, hybk: "房地产开", zttj: { days: 2, ct: 2 } },
      { c: "600001", n: "邯郸钢铁", p: 2500, zdp: 10.08, lbc: 1, zbc: 1, fund: null, hybk: null, zttj: {} },
    ],
  },
};

const brokenPayload = {
  data: {
    pool: [
      // 炸板后回落，涨跌幅是负的——这是正常的，不是脏数据
      { c: "605136", n: "丽人丽妆", p: 10400, zdp: -8.9317, lbc: null, zbc: 1, fund: null, hybk: "互联网电", zttj: { days: 4, ct: 3 } },
    ],
  },
};

const downPayload = { data: { pool: [{ c: "605069", n: "正和生态", p: 11060, zdp: -10.008, lbc: null, zbc: null, fund: 2755278, hybk: "环境治理", zttj: {} }] } };

test("价格 ÷1000 还原（原始值是 ×1000 的整数）", () => {
  const { rows } = parsePool(upPayload, "limitUp");
  assert.equal(rows[0]!.price, 6.3, "p=6300 → 6.30 元");
  assert.equal(rows[1]!.price, 22.62);
});

test("炸板池涨跌幅是负的，照样收（不是脏数据）", () => {
  const { rows, bad } = parsePool(brokenPayload, "broken");
  assert.equal(bad, 0);
  assert.equal(rows[0]!.pct < 0, true, "炸板后回落，涨跌幅为负");
  assert.equal(rows[0]!.streak, null, "炸板池没有连板数——null 不是 0");
});

test("连板数 null 不冒充 0（0 会被读成首板）", () => {
  const { rows } = parsePool(brokenPayload, "broken");
  assert.equal(rows[0]!.streak, null);
  assert.equal(rows[0]!.breaks, 1);
});

test("zttj 整个缺失时 stat 是 null，不编「0天0板」", () => {
  const { rows } = parsePool(upPayload, "limitUp");
  assert.equal(rows[2]!.stat, null, "zttj 是 {} → 没有 N天M板");
  assert.equal(rows[0]!.stat, "2天2板");
});

test("坏行跳过并计数，不毁掉整页", () => {
  const { rows, bad } = parsePool(
    { data: { pool: [{ c: "530", n: "代码不够位" }, { c: "000530", n: "缺价格" }, { c: "000530", n: "冰山冷热", p: 6300 }] } },
    "limitUp",
  );
  assert.equal(rows.length, 1);
  assert.equal(bad, 2);
});

test("池不是数组 / 整个缺 data 时给空表不崩", () => {
  assert.deepEqual(parsePool(null, "limitUp"), { rows: [], bad: 0 });
  assert.deepEqual(parsePool({ data: null }, "broken"), { rows: [], bad: 0 });
  assert.deepEqual(parsePool({ data: { pool: null } }, "limitDown"), { rows: [], bad: 0 });
});

test("连板梯队：几连板有几只，null 不计入", () => {
  const { rows } = parsePool(upPayload, "limitUp");
  assert.deepEqual(streakLadder(rows), [
    { streak: 1, count: 1 },
    { streak: 2, count: 2 },
  ]);
  const { rows: brokenRows } = parsePool(brokenPayload, "broken");
  assert.deepEqual(streakLadder(brokenRows), [], "炸板池全是 null，不出梯队");
});

test("炸板率分母是「曾经涨停过的全部」", () => {
  const up = parsePool(upPayload, "limitUp").rows;
  const broken = parsePool(brokenPayload, "broken").rows;
  // 3 涨停 + 1 炸板 = 曾经涨停 4 只，炸了 1 只 → 25%
  assert.equal(breakRate(up, broken), 0.25);
  assert.equal(breakRate([], []), null, "都空时给 null，不给 0");
});

test("内部 id：北交所/沪/深分别判", () => {
  assert.equal(rowIdOf("600519"), "sh600519");
  assert.equal(rowIdOf("000001"), "sz000001");
  assert.equal(rowIdOf("300725"), "sz300725");
  assert.equal(rowIdOf("688356"), "sh688356");
  assert.equal(rowIdOf("920000"), "bj920000", "北交所新段");
  assert.equal(rowIdOf("430047"), "bj430047", "北交所老段");
});

test("汇总：三个池都空时给 null（页面显示没数据，不是全 0）", () => {
  assert.equal(summarize([], [], []), null);
  const up = parsePool(upPayload, "limitUp").rows;
  const broken = parsePool(brokenPayload, "broken").rows;
  const down = parsePool(downPayload, "limitDown").rows;
  const s = summarize(up, broken, down)!;
  assert.equal(s.limitUp, 3);
  assert.equal(s.broken, 1);
  assert.equal(s.limitDown, 1);
  assert.equal(s.breakRate, 0.25);
  assert.equal(s.topSealFund[0]!.name, "冰山冷热", "封板资金最大");
  assert.equal(s.topSealFund[0]!.sealFund, 367048974);
  assert.ok(s.topIndustries.length > 0);
  // 没有行业的票不计入行业分布（null 跳过，不并进"未知"）
  assert.ok(s.topIndustries.every((i) => i.industry.length > 0));
});

test("封板资金排序：null 的排不进来（不是当 0 排最后）", () => {
  const up = parsePool(upPayload, "limitUp").rows;
  const s = summarize(up, [], [])!;
  assert.equal(s.topSealFund.length, 2, "第 3 只没有封板资金，不进来");
  assert.ok(s.topSealFund.every((r) => r.sealFund != null));
});
