/**
 * 这个文件是干什么的：
 * 钉住业绩预告的口径。重点是**同比 vs 环比千万别混**——
 * 实测那条「略增」的公司同比 +31.9% 但环比 -25%~-50%，只显示一个会读反。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buybackTone,
  forecastTone,
  groupByCompany,
  holderTone,
  parseBuybacks,
  parseHolderTrades,
  parseIpos,
  parsePledges,
  parseSurveys,
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

// ── 股东增减持 ────────────────────────────────────────────────────────

/** 实测行：2026-10-16 河钢资源 000923，河钢集团增持 34 万股。 */
const REAL_HOLDER = {
  SECUCODE: "000923.SZ",
  SECURITY_CODE: "000923",
  SECURITY_NAME_ABBR: "河钢资源",
  NOTICE_DATE: "2026-10-16 00:00:00",
  START_DATE: "2026-07-15 00:00:00",
  END_DATE: "2026-10-15 00:00:00",
  DIRECTION: "增持",
  HOLDER_NAME: "河钢集团有限公司",
  CHANGE_NUM: 34,
  HOLD_RATIO: 35.7,
  TRADE_AVERAGE_PRICE: 14.7015,
  MARKET: "二级市场",
  CLOSE_PRICE: 14.42,
  // 下面两个字段**故意不给页面用**（口径和 DIRECTION 对不上，见解析层注释）
  CHANGE_RATE: -5.9361,
  CHANGE_FREE_RATIO: 0.05,
};

test("增减持：解析真实行（河钢集团增持河钢资源）", () => {
  const { rows, bad } = parseHolderTrades([REAL_HOLDER]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "000923");
  assert.equal(r.id, "sz000923");
  assert.equal(r.direction, "增持");
  assert.equal(r.holder, "河钢集团有限公司");
  assert.equal(r.shares, 34, "万股");
  assert.equal(r.holdRatio, 35.7, "变动后持股比例");
  assert.equal(r.avgPrice, 14.7015);
  assert.equal(r.channel, "二级市场");
  assert.equal(holderTone(r.direction), "positive");
});

test("增减持：CHANGE_RATE 这种口径对不上的字段不进解析结果", () => {
  const { rows } = parseHolderTrades([REAL_HOLDER]);
  const keys = Object.keys(rows[0]!).join(",");
  assert.ok(!keys.includes("changeRate"), "DIRECTION=增持 而 CHANGE_RATE=-5.94，摆上页面就是误导");
});

test("增减持：倾向只认增持/减持，别的措辞不表态", () => {
  assert.equal(holderTone("减持"), "negative");
  assert.equal(holderTone("增持"), "positive");
  assert.equal(holderTone("其他"), null);
  assert.equal(holderTone(""), null);
});

test("增减持：坏行跳过并计数", () => {
  const { rows, bad } = parseHolderTrades([REAL_HOLDER, { SECURITY_CODE: "923", SECURITY_NAME_ABBR: "代码不对位" }]);
  assert.equal(rows.length, 1);
  assert.equal(bad, 1);
});

// ── 机构调研 ──────────────────────────────────────────────────────────

/** 实测行：2026-10-16 京东方A 000725，10-15 接待，南方基金等 3 家。 */
const REAL_SURVEY = {
  SECUCODE: "000725.SZ",
  SECURITY_CODE: "000725",
  SECURITY_NAME_ABBR: "京东方A",
  NOTICE_DATE: "2026-10-16 00:00:00",
  RECEIVE_START_DATE: "2026-10-15 00:00:00",
  RECEIVE_END_DATE: null,
  RECEIVE_OBJECT: "南方基金",
  RECEIVE_WAY_EXPLAIN: "特定对象调研,现场参观",
  RECEIVE_PLACE: "京东方技术创新中心",
  SUM: 3,
  IS_SOURCE: "1",
  NUMBERNEW: "1",
};

test("调研：解析真实行（京东方A 接待 3 家机构）", () => {
  const { rows, bad } = parseSurveys([REAL_SURVEY]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "000725");
  assert.equal(r.noticeDate, "2026-10-16", "公告日");
  assert.equal(r.receiveDate, "2026-10-15", "实际接待日早于公告日");
  assert.equal(r.orgCount, 3, "SUM 是参与机构家数（汇总模式一次调研一行）");
  assert.equal(r.object, "南方基金");
  assert.equal(r.way, "特定对象调研,现场参观");
  assert.equal(r.place, "京东方技术创新中心");
});

test("调研：缺字段给 null 不编（接待对象/方式经常不写）", () => {
  const { rows } = parseSurveys([{ ...REAL_SURVEY, RECEIVE_OBJECT: null, RECEIVE_WAY_EXPLAIN: "", RECEIVE_PLACE: null, SUM: null }]);
  assert.equal(rows[0]!.object, null);
  assert.equal(rows[0]!.way, null);
  assert.equal(rows[0]!.orgCount, null, "SUM 缺就是 null，不是 0 家");
});

// ── 股票回购 ──────────────────────────────────────────────────────────

/** 实测行：2026-10-16 三花智控 002050，实施中，计划 2~4 亿。 */
const REAL_BUYBACK = {
  SECUCODE: "002050.SZ",
  DIM_SCODE: "002050",
  SECURITYSHORTNAME: "三花智控",
  REPURPROGRESS: "004",
  REPURSTARTDATE: "2026-07-27 00:00:00",
  REPURENDDATE: "2027-07-27 00:00:00",
  REPURPRICECAP: 59.88,
  REPURNUMLOWER: 3340014,
  REPURNUMCAP: 6680026,
  REPURAMOUNTLOWER: 200000000,
  REPURAMOUNTLIMIT: 400000000,
  REPURNUM: 5813422,
  REPURAMOUNT: 207951337.84,
  REPURPRICELOWER1: 32.34,
  REPURPRICECAP1: 37,
  UPDATEDATE: "2026-09-22 00:00:00",
  NOTICEDATE: "2026-10-16 00:00:00",
  REPUROBJECTIVE: "基于对未来持续稳定发展的信心和对公司价值的认可",
};

test("回购：解析真实行（三花智控实施中）", () => {
  const { rows, bad } = parseBuybacks([REAL_BUYBACK]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "002050", "**代码字段是 DIM_SCODE 不是 SECURITY_CODE**");
  assert.equal(r.progressCode, "004");
  assert.equal(r.progress, "实施中");
  assert.equal(r.priceCap, 59.88);
  assert.equal(r.sharesLower, 3340014);
  assert.equal(r.amountUpper, 400000000);
  assert.equal(r.doneShares, 5813422);
  assert.equal(r.doneAmount, 207951337.84);
  assert.equal(r.donePriceLow, 32.34);
  assert.equal(r.latestNotice, "2026-09-22", "UPDATEDATE 优先于 NOTICEDATE");
  assert.equal(buybackTone(r.progressCode), "positive");
});

test("回购：进度码只映射实测的三个，其余给 null（不猜）", () => {
  const { rows } = parseBuybacks([
    { ...REAL_BUYBACK, REPURPROGRESS: "001" },
    { ...REAL_BUYBACK, DIM_SCODE: "000001", REPURPROGRESS: "002" },
    { ...REAL_BUYBACK, DIM_SCODE: "000002", REPURPROGRESS: "007" }, // skill 提到存在但东财自己不显示名称
  ]);
  assert.equal(rows.find((r) => r.code === "002050")!.progress, "董事会预案");
  assert.equal(rows.find((r) => r.code === "000001")!.progress, "股东大会通过");
  assert.equal(rows.find((r) => r.code === "000002")!.progress, null, "007 认不出，页面显示原码");
});

test("回购：未开始实施的 done 字段是 null 不是 0", () => {
  const { rows } = parseBuybacks([{ ...REAL_BUYBACK, REPURPROGRESS: "001", REPURNUM: null, REPURAMOUNT: null, REPURPRICELOWER1: null, REPURPRICECAP1: null }]);
  assert.equal(rows[0]!.doneShares, null, "0 股会被读成「回购了 0 股」，其实是没开始");
  assert.equal(rows[0]!.doneAmount, null);
  assert.equal(buybackTone("001"), null, "预案只是流程节点，不表态");
});

// ── 股权质押 ──────────────────────────────────────────────────────────

/** 实测行：2026-10-09 统计日，信通电子 001388。 */
const REAL_PLEDGE = {
  SECUCODE: "001388.SZ",
  SECURITY_CODE: "001388",
  SECURITY_NAME_ABBR: "信通电子",
  TRADE_DATE: "2026-10-09 00:00:00",
  INDUSTRY: "通信设备",
  PLEDGE_RATIO: 0.23,
  PLEDGE_MARKET_CAP: 1063.26,
  PLEDGE_DEAL_NUM: 3,
};

test("质押：解析真实行（信通电子，周频统计日 10-09）", () => {
  const { rows, bad } = parsePledges([REAL_PLEDGE]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "001388");
  assert.equal(r.date, "2026-10-09", "**统计日是 TRADE_DATE 不是 NOTICE_DATE**");
  assert.equal(r.pledgeRatio, 0.23);
  assert.equal(r.pledgeMktCap, 1063.26);
  assert.equal(r.industry, "通信设备");
});

test("质押：按质押比例降序（风险高的在前）", () => {
  const low = { ...REAL_PLEDGE, SECURITY_CODE: "000001", SECURITY_NAME_ABBR: "A", PLEDGE_RATIO: 0.05 };
  const high = { ...REAL_PLEDGE, SECURITY_CODE: "000002", SECURITY_NAME_ABBR: "B", PLEDGE_RATIO: 8.5 };
  const { rows } = parsePledges([low, high]);
  assert.deepEqual(rows.map((r) => r.code), ["000002", "000001"]);
});

test("质押：坏行跳过并计数", () => {
  const { rows, bad } = parsePledges([REAL_PLEDGE, { SECURITY_CODE: "388", SECURITY_NAME_ABBR: "代码不对位" }]);
  assert.equal(rows.length, 1);
  assert.equal(bad, 1);
});

// ── 新股申购 ──────────────────────────────────────────────────────────

/** 实测行：2026-10-16 皇冠新材，橡胶和塑料制品业。 */
const REAL_IPO = {
  SECUCODE: "001388.SZ",
  SECURITY_CODE: "001388",
  SECURITY_NAME: "皇冠新材",
  APPLY_CODE: "001388",
  MARKET: "深交所主板",
  MARKET_TYPE_NEW: "深交所其他",
  INDUSTRY_NAME: "橡胶和塑料制品业",
  APPLY_DATE: "2026-10-16 00:00:00",
  BALLOT_NUM_DATE: "2026-10-19 00:00:00",
  BALLOT_PAY_DATE: "2026-10-20 00:00:00",
  LISTING_DATE: null,
  ISSUE_PRICE: 18.88,
  AFTER_ISSUE_PE: 25.87,
  INDUSTRY_PE: 27.65,
  TOP_APPLY_MARKETCAP: 13.5,
  ONLINE_ISSUE_LWR: null,
};

test("新股：解析真实行（皇冠新材，顶格需配 13.5 万市值）", () => {
  const { rows, bad } = parseIpos([REAL_IPO]);
  assert.equal(bad, 0);
  const r = rows[0]!;
  assert.equal(r.code, "001388");
  assert.equal(r.name, "皇冠新材");
  assert.equal(r.board, "深交所主板", "**MARKET 优先于 MARKET_TYPE_NEW**（后者把未上市标成「其他」）");
  assert.equal(r.industry, "橡胶和塑料制品业");
  assert.equal(r.applyDate, "2026-10-16");
  assert.equal(r.ballotDate, "2026-10-19");
  assert.equal(r.payDate, "2026-10-20");
  assert.equal(r.issuePrice, 18.88);
  assert.equal(r.issuePe, 25.87);
  assert.equal(r.industryPe, 27.65);
  assert.equal(r.topApplyMktCap, 13.5);
  assert.equal(r.listingDate, "", "未上市 → 空串，页面显示「未上市」");
  assert.equal(r.winRate, null, "中签率未公布 → null 不是 0");
});

test("新股：发行价 0 当没定价（0 不是「免费」）", () => {
  const { rows } = parseIpos([{ ...REAL_IPO, ISSUE_PRICE: 0 }]);
  assert.equal(rows[0]!.issuePrice, null, "定价前东财填 null 或 0，都当没定价");
});

test("新股：北交所只有 MARKET_TYPE_NEW 有值，回退取它", () => {
  const { rows } = parseIpos([{ ...REAL_IPO, MARKET: null, MARKET_TYPE_NEW: "北交所" }]);
  assert.equal(rows[0]!.board, "北交所", "北交所新股只有后者有值（skill 原文）");
});

test("新股：按申购日降序（最新的在前）", () => {
  const older = { ...REAL_IPO, SECURITY_CODE: "000001", SECURITY_NAME: "A", APPLY_DATE: "2026-10-10 00:00:00" };
  const { rows } = parseIpos([older, REAL_IPO]);
  assert.deepEqual(rows.map((r) => r.code), ["001388", "000001"]);
});
