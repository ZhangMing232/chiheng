/**
 * 这个文件是干什么的：
 * 钉住因子表达式的编译和求值。表达式是 AI 产出进系统的唯一入口，
 * 这里的测试就是入口的安检门：
 *   1. 四则运算 / 括号 / 函数 / 一元负号算得对
 *   2. 白名单外的标识符、不配对的括号、残缺的表达式 → 编译失败（不是运行时炸）
 *   3. null 操作数、除零、负数开方 → 结果是 null，不是 NaN 混进分档
 *   4. 没有任何 eval：想绕过白名单注入代码，第一步就过不了编译
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compileFactorExpr, validateFactorExpr } from "@/lib/market/factor-expr";
import type { MetricRow } from "@/lib/market/factors";

/** 只填测试用到的字段，其余 null。字段都是 number|null，缺省就是 null。 */
function row(partial: Partial<MetricRow>): MetricRow {
  return {
    c: null,
    prev: null,
    open: null,
    low: null,
    prevLow: null,
    chg: null,
    d5: null,
    d10: null,
    d20: null,
    d60: null,
    momAccel: null,
    rsi14: null,
    bias20: null,
    std20: null,
    std60: null,
    amp20: null,
    corrVRet: null,
    shrinkDays: null,
    distHigh20: null,
    distLow60: null,
    bollB: null,
    rangePos20: null,
    volRatio: null,
    volShrink: null,
    amountWan: null,
    turnover: null,
    floatCap: null,
    lowerWick: null,
    volCompress: null,
    downStreak: null,
    springStrength: null,
    springAge: null,
    springLow: null,
    springRangeHigh: null,
    ...partial,
  } as MetricRow;
}

test("四则运算与优先级", () => {
  const get = compileFactorExpr("std20 / amp20 + 1");
  assert.equal(get(row({ std20: 4, amp20: 2 })), 3);
});

test("括号改变优先级", () => {
  const get = compileFactorExpr("(std20 + amp20) * 2");
  assert.equal(get(row({ std20: 4, amp20: 2 })), 12);
});

test("函数嵌套与一元负号", () => {
  assert.equal(compileFactorExpr("abs(d60)")(row({ d60: -3 })), 3);
  assert.equal(compileFactorExpr("-d60")(row({ d60: 3 })), -3);
  assert.equal(compileFactorExpr("sqrt(abs(d60))")(row({ d60: -9 })), 3);
  assert.equal(compileFactorExpr("log(floatCap)")(row({ floatCap: Math.E })), 1);
});

test("一元符号只允许 +/-，* / 不行", () => {
  assert.equal(compileFactorExpr("+d60")(row({ d60: 3 })), 3);
  assert.throws(() => compileFactorExpr("*d60"), /一元符号/);
});

test("白名单外的标识符直接编译失败", () => {
  assert.throws(() => compileFactorExpr("fetch(1)"), /不在白名单/);
  assert.throws(() => compileFactorExpr("constructor"), /不在白名单/);
  assert.throws(() => compileFactorExpr("process.env"), /不在白名单|无法识别/);
});

test("函数当变量用（abs 不带括号）编译失败", () => {
  assert.throws(() => compileFactorExpr("abs std20"), /结尾不完整|缺括号/);
});

test("括号不配对 / 空表达式 / 残缺表达式编译失败", () => {
  assert.throws(() => compileFactorExpr("std20 + "), /不完整/);
  assert.throws(() => compileFactorExpr("(std20"), /左括号/);
  assert.throws(() => compileFactorExpr("std20)"), /右括号/);
  assert.throws(() => compileFactorExpr(""), /不完整|空的/);
});

test("null 操作数 → null，不硬算", () => {
  const get = compileFactorExpr("std20 / amp20");
  assert.equal(get(row({ std20: 4, amp20: null })), null);
  assert.equal(get(row({ std20: null, amp20: 2 })), null);
});

test("除零 / 负数开方 / 非数 → null，不是 NaN", () => {
  assert.equal(compileFactorExpr("std20 / amp20")(row({ std20: 4, amp20: 0 })), null);
  assert.equal(compileFactorExpr("sqrt(std20)")(row({ std20: -4 })), null);
  assert.equal(compileFactorExpr("log(0)")(row({})), null);
});

test("数值字面量", () => {
  assert.equal(compileFactorExpr("0.5 * d60")(row({ d60: 10 })), 5);
  assert.equal(compileFactorExpr("2.5")(row({})), 2.5);
  assert.throws(() => compileFactorExpr("1.2.3 + d60"), /不合法/);
});

test("validateFactorExpr：错给错误消息，对给求值函数", () => {
  const bad = validateFactorExpr("hack()");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /不在白名单/);
  const good = validateFactorExpr("std20 * volShrink");
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.get(row({ std20: 2, volShrink: 3 })), 6);
});
