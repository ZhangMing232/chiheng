/**
 * 这个文件是干什么的：
 * 钉住财务公式——**单位错抛错、跨零无意义、百分数误传要炸**。
 *
 * 三条各对应一个静默错误：
 * 1. 单位差一万倍（亿 vs 元），PE 从 19 变成 0.0019，数字看着正常其实全错。
 * 2. EPS 跨零时年化增速在数学上无定义（负数的分数次幂是复数）。
 * 3. 把 5.9 当 0.059 传给 PEG，结果大 100 倍——这种错必须炸出来，不能默默给数。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forwardCagr, fxConvert, peg, pegSafe, peFromCapProfit, toYuan } from "@/lib/market/formulas";

test("单位归一：亿/万/元 → 元", () => {
  assert.equal(toYuan(16101, "亿"), 16101e8);
  assert.equal(toYuan(50, "万元"), 50e4);
  assert.equal(toYuan(1288, "元"), 1288);
});

test("单位不认识抛错，不猜", () => {
  assert.throws(() => toYuan(100, "万亿"), /单位不认识/);
});

test("PE = 市值÷利润，各自带单位内部归一", () => {
  // 茅台：市值 16101 亿、TTM 净利 844 亿 → PE ≈ 19.08
  const pe = peFromCapProfit(16101, "亿", 844, "亿");
  assert.ok(Math.abs((pe as number) - 16101 / 844) < 1e-9);
});

test("PE 混合单位：亿市值 ÷ 元利润", () => {
  // 844 亿 = 844e8 元
  const pe = peFromCapProfit(16101, "亿", 844e8, "元");
  assert.ok(Math.abs((pe as number) - 16101 / 844) < 1e-9, "亿/元混用也要对");
});

test("亏损 → PE 无意义（null 不是 0）", () => {
  assert.equal(peFromCapProfit(100, "亿", -5, "亿"), null);
});

test("forwardCagr：(b/a)^(1/n) − 1", () => {
  // 今年 65、两年后 71.5 → 年化约 4.86%
  const c = forwardCagr(65, 71.5, 2)!;
  assert.ok(Math.abs(c - (Math.pow(71.5 / 65, 1 / 2) - 1)) < 1e-12);
});

test("forwardCagr：EPS 跨零 → null（负数分数次幂无意义）", () => {
  assert.equal(forwardCagr(-10, 50, 2), null);
  assert.equal(forwardCagr(10, -50, 2), null);
  assert.equal(forwardCagr(0, 50, 2), null);
});

test("PEG = PE ÷ (CAGR×100)", () => {
  assert.ok(Math.abs(peg(19.7, 0.059) - 19.7 / 5.9) < 1e-9);
});

test("PEG：百分数误传要炸（5.9 当 0.059 传，结果会大 100 倍）", () => {
  assert.throws(() => peg(19.7, 5.9), /百分数当成小数/);
});

test("PEG：PE ≤ 0 或 CAGR ≤ 0 抛错", () => {
  assert.throws(() => peg(-1, 0.05), /PE=.*≤ 0/);
  assert.throws(() => peg(19.7, -0.05), /CAGR=.*≤ 0/);
});

test("pegSafe：算不出给 null 不炸（页面用）", () => {
  assert.equal(pegSafe(null, 0.05), null);
  assert.equal(pegSafe(19.7, null), null);
  assert.equal(pegSafe(19.7, 5.9), null, "误传也被安全版吃掉，返回 null");
  assert.ok((pegSafe(19.7, 0.059) as number) > 0);
});

test("fxConvert：换成本币乘、换出报价币种除", () => {
  // 基准美元，1 美元 = 7.1 元
  // 基准美元、1 美元 = 7.1 元：100 美元是基准币种 → 乘 = 710 元；710 元换回美元 → 除
  assert.equal(fxConvert(100, "美元", "元", 7.1, "美元"), 710);
  assert.equal(fxConvert(710, "元", "美元", 7.1, "美元"), 100);
});

test("fxConvert：缺交叉汇率抛错，不猜", () => {
  assert.throws(() => fxConvert(100, "港元", "元", 7.1, "美元"), /交叉汇率/);
});

test("fxConvert：同币种原样返回", () => {
  assert.equal(fxConvert(100, "元", "元", 7.1, "美元"), 100);
});
