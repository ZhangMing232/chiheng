/**
 * 这个文件是干什么的：
 * 钉住数字闸门的两侧——**该拦的拦住，该放的别误伤**。
 *
 * 误伤的代价比漏拦大：如果正常复述的数字被拦掉，AI 会学会什么都不说，
 * 研判页就退化成一堆「（略※）」。所以「材料里有就放行」这条要测得很细。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NUMBER_MARK, screenNumbers } from "@/lib/market/number-gate";

const SOURCES = ["茅台 2026-10-09 收盘 1263.00 元，市盈率 TTM 19.39 倍，市净率 6.28。换手率 0.28%。"];

test("材料里有的数字放行", () => {
  const r = screenNumbers("茅台今天收盘 1263.00 元。", SOURCES);
  assert.equal(r.replaced.length, 0);
  assert.match(r.text, /1263\.00/);
});

test("材料里没有的数字换成（略※），不整段打回", () => {
  const r = screenNumbers("茅台今天收盘 1263.00 元，明天我看 1500 元。", SOURCES);
  assert.deepEqual(r.replaced, ["1500"]);
  assert.match(r.text, /1263\.00/, "有出处的数字必须留住");
  assert.match(r.text, new RegExp(NUMBER_MARK), "没出处的要换掉");
  assert.match(r.text, /明天我看/, "周围的文字不能丢");
});

test("换数字时连同单位一起换，不留「（略※）亿元」", () => {
  const r = screenNumbers("这只票市值 3000 亿元。", SOURCES);
  assert.equal(r.replaced.length, 1);
  assert.ok(!r.text.includes("亿元"), `单位要跟着换掉，实际：${r.text}`);
});

test("日期、钟点、序号、参数组不核对", () => {
  const r = screenNumbers("2026-10-09 09:30 开盘。第一条 (12,26,9)。近 30 天在涨。", SOURCES);
  assert.deepEqual(r.replaced, [], `这些不是数据点，实际换了：${r.replaced.join(",")}`);
});

test("「假设」小句里的数字是举例，不核对；同行的真数据照查", () => {
  const r = screenNumbers("假设明年增长 10%，市盈率就到了 19.39 倍。", SOURCES);
  assert.deepEqual(r.replaced, [], "假设句放行");
  const r2 = screenNumbers("假设明年增长 10%，市盈率就到了 88 倍。", SOURCES);
  assert.deepEqual(r2.replaced, ["88"], "假设豁免不能顺带放过同行的假数字");
});

test("闭合且标了语言的代码块不核对；没闭合的照查", () => {
  const ok = screenNumbers("```python\nx = 999999\n```", SOURCES);
  assert.deepEqual(ok.replaced, [], "闭合的代码块不查");

  const notClosed = screenNumbers("```python\nx = 999999", SOURCES);
  assert.deepEqual(notClosed.replaced, ["999999"], "没闭合的围栏照常核对，否则塞代码块就能绕过去");
});

test("千分位兼容：源里写 1,235.58 也认 1235.58", () => {
  const r = screenNumbers("收盘 1235.58 元。", ["某材料写 1,235.58 元"]);
  assert.deepEqual(r.replaced, []);
});

test("容差按位数：「33 亿」源里有 33 就放行", () => {
  const r = screenNumbers("市值 33 亿。", ["材料：市值约 33"]);
  assert.deepEqual(r.replaced, []);
});

test("材料里一个数字都没有 → 这段的数字全换，并标出 sourcesEmpty", () => {
  const r = screenNumbers("营收 500 亿，净利 80 亿。", ["材料里没有任何数字"]);
  assert.equal(r.sourcesEmpty, true);
  assert.equal(r.replaced.length, 2);
});

test("sourcesEmpty 时也逐个换，不整段打回", () => {
  const r = screenNumbers("营收 500 亿，同比增长明显。", []);
  assert.match(r.text, /同比增长明显/, "文字要留住");
  assert.ok(!r.text.includes("500"));
});

test("回归：材料无数字时，时间窗口/日期照样豁免，不能抄近路全换", () => {
  // 以前 sourcesEmpty 分支直接 replace(NUM)，把「近 20 日」这种窗口长度也换掉了。
  const r = screenNumbers("近 20 日涨幅掉头，2026-10-09 开盘，第一条。", []);
  assert.deepEqual(r.replaced, [], `窗口和日期不是数据点，实际换了：${r.replaced.join(",")}`);
  assert.match(r.text, /近 20 日/);
  assert.match(r.text, /2026-10-09/);
});
