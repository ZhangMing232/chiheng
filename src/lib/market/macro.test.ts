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
import { parseYieldCurve, snapshotOf, spreadOf } from "@/lib/market/macro";

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