/**
 * 这个文件是干什么的：
 * 钉住业绩预告的口径。重点是**同比 vs 环比千万别混**——
 * 实测那条「略增」的公司同比 +31.9% 但环比 -25%~-50%，只显示一个会读反。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forecastTone,
  groupByCompany,
  parseForecast,
  yoyOf,
  type ForecastRow,
} from "@/lib/market/events";

/** 实测的一行（2026-10-15 新北洋 002376，略增）。 */
const REAL = {
  SECUCODE: "002376.SZ",
  SECURITY_CODE: "002376",
  SECURITY_NAME_ABBR: "新北洋",
  NOTICE_DATE: "2026-10-15 00:00:00",
  REPORT_DATE: "2026-09-30 00:00:00",
  PREDICT_FINANCE: "每股收益",
  PREDICT_TYPE: "略增",
  FORECAST_JZ: 0.10145,
  PREYEAR_SAME_PERIOD: 0.0769,
  PREDICT_RATIO_LOWER: -50.18115942029,
  PREDICT_RATIO_UPPER: -25,
  CHANGE_REASON_EXPLAIN: "2026年前三季度,公司各核心业务增长动能充足",
  IS_LATEST: "T",
};

test("解析真实行：同比和环比是**两个**口径，各自独立", () => {
  const { rows, bad } = parseForecast([REAL]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "002376");
  assert.equal(r.id, "sz002376");
  assert.equal(r.kind, "略增", "公司措辞原样保留");
  assert.equal(r.item, "每股收益");
  assert.ok(r.yoyPct! > 30, `同比约 +31.9%，实际 ${r.yoyPct}`);
  assert.ok(r.qoqHigh! < 0, `环比 -25%~-50%，实际 ${r.qoqLow}~${r.qoqHigh}`);
  assert.ok(r.reason?.includes("增长动能"));
});

test("同比是我们算的；去年为 0 或缺就不可算（不给 0）", () => {
  assert.equal(yoyOf(0.10145, 0.0769)!.toFixed(1), "31.9");
  assert.equal(yoyOf(0.1, null), null, "缺去年值→不可算，不是 0%");
  assert.equal(yoyOf(0.1, 0), null, "去年是 0→除不出，不给夸张的数");
  assert.equal(yoyOf(null, 1), null);
});

test("去年是负数时用绝对值做分母（避免符号翻转）", () => {
  // 去年 -0.1 今年 0.05 → 改善了 150%，不是 -150%
  assert.equal(yoyOf(0.05, -0.1), 150);
});

test("倾向只按公司措辞判，略增/持平不表态", () => {
  assert.equal(forecastTone("预增"), "positive");
  assert.equal(forecastTone("扭亏"), "positive");
  assert.equal(forecastTone("首亏"), "negative");
  assert.equal(forecastTone("略减"), "negative");
  assert.equal(forecastTone("略增"), null, "「略增」是我们不表态的那一档");
  assert.equal(forecastTone("持平"), null);
  assert.equal(forecastTone("不确定"), null);
  assert.equal(forecastTone("没见过的措辞"), null, "认不出的措辞不给倾向，不硬套");
});

test("一次预告按指标拆多行时，按票能聚起来", () => {
  const second = { ...REAL, PREDICT_FINANCE: "净利润", SECURITY_CODE: "002376", PREDICT_FINANCE_CODE: "001" };
  const other = { ...REAL, SECUCODE: "600519.SH", SECURITY_CODE: "600519", SECURITY_NAME_ABBR: "贵州茅台" };
  const { rows } = parseForecast([REAL, second, other]);
  const groups = groupByCompany(rows);
  assert.equal(groups.length, 2, "两只票");
  assert.equal(groups[0]!.items.length, 2, "新北洋有两行（每股收益 + 净利润）");
  assert.equal(groups[0]!.code, "002376", "公告日相同时按代码升序排（002376 < 600519），顺序稳定");
});

test("坏行跳过并计数，不毁掉整页", () => {
  const { rows, bad } = parseForecast([REAL, { SECURITY_CODE: "376", SECURITY_NAME_ABBR: "代码不对位" }, { SECURITY_NAME_ABBR: "没有代码" }]);
  assert.equal(rows.length, 1);
  assert.equal(bad, 2);
});

test("公告日倒序（同日按代码，刷新一次顺序不能变）", () => {
  const older = { ...REAL, SECURITY_CODE: "000001", SECURITY_NAME_ABBR: "A", NOTICE_DATE: "2026-10-10 00:00:00" };
  const newer = { ...REAL, SECURITY_CODE: "000002", SECURITY_NAME_ABBR: "B", NOTICE_DATE: "2026-10-14 00:00:00" };
  const { rows } = parseForecast([older, newer]);
  assert.deepEqual(rows.map((r) => r.code), ["000002", "000001"]);
});

test("北交所的 id 前缀是 bj（不是 sh）", () => {
  const bj = { ...REAL, SECUCODE: "920000.BJ", SECURITY_CODE: "920000" };
  assert.equal(parseForecast([bj]).rows[0]!.id, "bj920000");
});
