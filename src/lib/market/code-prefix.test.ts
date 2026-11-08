/**
 * 代码前缀映射守门：6 份重复实现统一到 code-prefix.ts 之后，钉死边界。
 *
 * 老实现 `/^[6-9]/` 排在 `[48]` 前面，8/9 开头的北交所票会被错标成 sh，
 * 和 K 线缓存的 bj9 前缀对不上（缓存里实测有 40 只）。沪市 B 股 900xxx
 * 同样 9 开头但必须仍归 sh，所以北交所优先且只认 920/43/83/87/88。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { codePrefix } from "@/lib/market/code-prefix";

test("沪深主板 / 创业 / 科创：常规映射不变", () => {
  assert.equal(codePrefix("600000"), "sh600000");
  assert.equal(codePrefix("688001"), "sh688001");
  assert.equal(codePrefix("000001"), "sz000001");
  assert.equal(codePrefix("300750"), "sz300750");
  assert.equal(codePrefix("002594"), "sz002594");
});

test("沪市 B 股 900xxx 是 9 开头但归 sh，不能被误判成北交所", () => {
  assert.equal(codePrefix("900901"), "sh900901");
});

test("🔴 北交所 920/43/83/87/88 必须归 bj（老实现的死分支）", () => {
  for (const c of ["920001", "430047", "830799", "870199", "889999"]) {
    assert.equal(codePrefix(c), "bj" + c, `${c} 被错标了`);
  }
});

test("无法识别的原样返回，不硬造前缀", () => {
  assert.equal(codePrefix("abc"), "abc");
});
