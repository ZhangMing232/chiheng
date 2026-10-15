/**
 * 这个文件是干什么的：
 * 钉住中债收益率曲线的解析口径。fixture 用的是**真实返回的一行**
 * （2026-10-14 的国债曲线，实测值），不是编的。
 *
 * 重点：
 * 1. 收益率单位是 %（1.6516 = 1.6516%），不是小数——换算只在展示层
 * 2. 缺档给 null 不给 0（0 会被读成「收益率 0%」）
 * 3. 结果按日期升序排（官网倒序返回，但**别假设**，页面画曲线不用再排）
 * 4. 利差任一端缺值给 null（0 会被读成「曲线平坦」）
 * 5. 一条都没有时快照给 null，不给全 0
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lprSnapshotOf,
  parseLpr,
  parsePmi,
  parseYieldCurve,
  pmiZone,
  snapshotOf,
  spreadOf,
} from "@/lib/market/macro";

/** 真实返回的一行（2026-10-14 中债国债，实测）。 */
const REAL_ROW = `<tr><td>中债国债收益率曲线</td><td>2026-10-14</td><td>1.1699</td><td>1.1700</td><td>1.1872</td><td>1.2720</td><td>1.3896</td><td>1.4838</td><td>1.6516</td><td>2.0600</td></tr>`;

function table(inner: string): string {
  return `<html><body><table><tbody>${inner}</tbody></table></body></html>`;
}

test("解析真实行：八档期限 + 10年 = 1.6516%", () => {
  const { points, bad } = parseYieldCurve(table(REAL_ROW));
  assert.equal(bad, 0);
  assert.equal(points.length, 1);
  const p = points[0]!;
  assert.equal(p.date, "2026-10-14");
  assert.equal(p.tenors["3m"], 1.1699);
  assert.equal(p.tenors["10y"], 1.6516);
  assert.equal(p.tenors["30y"], 2.06);
});

test("单位是百分数不是小数（不偷偷除 100）", () => {
  const { points } = parseYieldCurve(table(REAL_ROW));
  assert.ok(points[0]!.tenors["10y"]! > 1, "1.6516 意思是 1.6516%，除 100 就成了 0.0166%");
});

test("表头行和注释被跳过，不当成数据", () => {
  const html = `<html><!-- 注释里有 <tr> --><table><tr><th>曲线名称</th><th>日期</th><th>3月</th></tr><tbody>${REAL_ROW}</tbody></table></html>`;
  const { points } = parseYieldCurve(html);
  assert.equal(points.length, 1, "表头不是数据，注释里的伪 tr 也不认");
  assert.equal(points[0]!.date, "2026-10-14");
});

test("缺档给 null 不给 0（0 会被读成收益率 0%）", () => {
  const row = `<tr><td>中债中短期票据收益率曲线</td><td>2026-10-14</td><td>1.5</td><td>1.6</td><td>1.7</td><td>1.8</td><td>2.0</td><td>2.2</td><td>2.4</td><td>--</td></tr>`;
  const { points } = parseYieldCurve(table(row));
  assert.equal(points[0]!.tenors["30y"], null, "中短期票据没有 30 年那一档");
  assert.equal(points[0]!.tenors["10y"], 2.4);
});

test("非数字算坏行计数，不静默当 0", () => {
  const row = `<tr><td>曲线</td><td>2026-10-14</td><td>abc</td><td></td><td>1.8</td><td>1.9</td><td>2.0</td><td>2.1</td><td>2.2</td><td>2.3</td></tr>`;
  const { points, bad } = parseYieldCurve(table(row));
  assert.equal(bad, 1, "abc 算坏行；空单元格不算（那是缺档）");
  assert.equal(points[0]!.tenors["3m"], null);
  assert.equal(points[0]!.tenors["6m"], null);
});

test("结果按日期升序（官网倒序返回，但别假设）", () => {
  const r1 = `<tr><td>曲线</td><td>2026-10-13</td><td>1.1</td><td>1.1</td><td>1.1</td><td>1.2</td><td>1.3</td><td>1.4</td><td>1.6</td><td>2.0</td></tr>`;
  const r2 = `<tr><td>曲线</td><td>2026-10-14</td><td>1.2</td><td>1.2</td><td>1.2</td><td>1.3</td><td>1.4</td><td>1.5</td><td>1.7</td><td>2.1</td></tr>`;
  const { points } = parseYieldCurve(table(r1 + r2));
  assert.deepEqual(points.map((p) => p.date), ["2026-10-13", "2026-10-14"]);
});

test("期限利差：任一端缺值给 null，不拿 0 充", () => {
  const { points } = parseYieldCurve(table(REAL_ROW));
  const p = points[0]!;
  const slope = spreadOf(p, "10y", "1y");
  assert.ok(slope != null);
  assert.ok(Math.abs(slope! - (1.6516 - 1.1872)) < 1e-6, "10y-1y = 0.4644");
  assert.equal(spreadOf(p, "30y", "99y"), null, "不存在的期限给 null");
  assert.equal(spreadOf({ date: "x", tenors: { "10y": null, "1y": 1.2 } }, "10y", "1y"), null);
});

test("快照取最新一天；一条都没有给 null（不显示全 0）", () => {
  const empty = snapshotOf([]);
  assert.equal(empty, null, "没数据时给 null——0 会被读成「收益率 0%」");
  const { points } = parseYieldCurve(table(REAL_ROW));
  const s = snapshotOf(points)!;
  assert.equal(s.date, "2026-10-14");
  assert.equal(s.days, 1);
  assert.ok(s.slope10y1y! > 0);
});

test("空表 / 非表格输入不崩", () => {
  assert.deepEqual(parseYieldCurve(""), { points: [], bad: 0 });
  assert.deepEqual(parseYieldCurve("<html>维护中</html>"), { points: [], bad: 0 });
});
// ── PMI ────────────────────────────────────────────────────────────────

/**
 * 真实正文片段（2026-10-15 实测，2026年9月）。
 * ⚠️ **括号里有空格**——「（ PMI ）为 50.1%」。这是 skill 文档里标🔴 的坑：
 * 只把空白压成单个空格的话一条都匹配不到，必须整个删掉。
 */
const REAL_PMI_BODY = `<html><body><div class="TRS_Editor">
  <p>2026年9月，中国采购经理指数运行情况。</p>
  <p>一、中国制造业采购经理指数（PMI）为 50.1%（见图1），比上月上升 0.1 个百分点，位于扩张区间。</p>
  <p>分企业规模看，大型企业PMI为 50.4%，小型企业PMI为 47.5%（详见表1）。</p>
  <p>二、非制造业商务活动指数为 50.2%（见图2），比上月上升 0.2 个百分点。</p>
  <p>三、综合PMI产出指数为 50.7%（见图3），比上月上升 0.3 个百分点。</p>
</div></body></html>`;

test("PMI：三个主指标 + 荣枯线判定", () => {
  const p = parsePmi(REAL_PMI_BODY);
  assert.equal(p.manufacturing, 50.1);
  assert.equal(p.nonManufacturing, 50.2);
  assert.equal(p.composite, 50.7);
  assert.equal(pmiZone(p.manufacturing), "expansion", "50.1 在扩张区间");
  assert.equal(pmiZone(49.2), "contraction");
  assert.equal(pmiZone(50), "flat", "刚好 50 是「持平」，不是扩张");
  assert.equal(pmiZone(null), null, "没数不给判定");
});

test("PMI：月份从标题/正文取，不是拉取日期", () => {
  assert.equal(parsePmi(REAL_PMI_BODY).month, "2026年9月");
});

test("PMI：大中小三种版式都认（①全合并 ②中小合并 ③全拆）", () => {
  // ⚠️ 替换正则要允许空格（\s*）：原始 HTML 里是「大型企业PMI为 50.4%」，
  // 写成无空格的正则会**匹配不上、替换不发生**，然后测试就变成在测版式③——
  // 我第一版就这么写错了，中型是 null 而不是我期望的 49.2。
  const v1 = parsePmi(REAL_PMI_BODY.replace(/大型企业PMI为\s*[\d.]+%，小型企业PMI为\s*[\d.]+%/u,
    "大、中、小型企业PMI分别为 50.4%、49.2% 和 47.5%"));
  assert.deepEqual([v1.large, v1.medium, v1.small], [50.4, 49.2, 47.5]);
  // ③ 全拆（本 fixture 本身就是这种）
  const v3 = parsePmi(REAL_PMI_BODY);
  assert.equal(v3.large, 50.4);
  assert.equal(v3.small, 47.5);
});

test("PMI：主体三个是必须的，大中小认不出给 null 不猜", () => {
  const p = parsePmi("<html><body><p>制造业采购经理指数（PMI）为 49.2%</p></body></html>");
  assert.equal(p.manufacturing, 49.2);
  assert.equal(p.large, null, "认不出就不给，不猜");
  assert.equal(p.nonManufacturing, null);
});

// ── LPR ────────────────────────────────────────────────────────────────

test("LPR：剔除旧贷款基准利率（LPR1Y 为空的行）", () => {
  const { points } = parseLpr([
    { TRADE_DATE: "2026-09-20T00:00:00.000Z", LPR1Y: 3, LPR5Y: 3.5 },
    { TRADE_DATE: "2015-10-24T00:00:00.000Z", LPR1Y: null, LPR5Y: null }, // 旧基准利率
    { TRADE_DATE: "1991-04-21T00:00:00.000Z", LPR1Y: "", LPR5Y: "" },
  ]);
  assert.equal(points.length, 1, "旧贷款利率不是 LPR，要剔掉");
  assert.equal(points[0]!.date, "2026-09-20");
  assert.equal(points[0]!.lpr1y, 3);
  assert.equal(points[0]!.lpr5y, 3.5);
});

test("LPR：5 年期在 2019-08 之前是 null（品种那时才设立）", () => {
  const { points } = parseLpr([{ TRADE_DATE: "2019-08-19", LPR1Y: 4.25, LPR5Y: null }]);
  assert.equal(points[0]!.lpr5y, null, "null 不是 0——0% 会被读成零利率");
  assert.equal(points[0]!.lpr1y, 4.25);
});

test("LPR：日期认不出算坏行；结果按日期升序", () => {
  const { points, bad } = parseLpr([
    { TRADE_DATE: "2026-08-20", LPR1Y: 3, LPR5Y: 3.5 },
    { TRADE_DATE: "不是日期", LPR1Y: 3, LPR5Y: 3.5 },
    { TRADE_DATE: "2026-09-20", LPR1Y: 3, LPR5Y: 3.5 },
  ]);
  assert.equal(bad, 1);
  assert.deepEqual(points.map((p) => p.date), ["2026-08-20", "2026-09-20"], "东财返回是倒序，统一升序");
});

test("LPR 快照取最新一次；空表给 null", () => {
  assert.equal(lprSnapshotOf([]), null);
  const { points } = parseLpr([
    { TRADE_DATE: "2026-08-20", LPR1Y: 3, LPR5Y: 3.5 },
    { TRADE_DATE: "2026-09-20", LPR1Y: 3, LPR5Y: 3.5 },
  ]);
  assert.equal(lprSnapshotOf(points)!.date, "2026-09-20");
});
