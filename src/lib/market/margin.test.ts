import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarginRow, parseMarginPage, marginSummary } from "@/lib/market/margin";

describe("parseMarginRow", () => {
  it("正常行：金额原样保留（元），ratio 是百分比", () => {
    const row = parseMarginRow({
      SCODE: "601318",
      SECNAME: "中国平安",
      RZYE: 35559273800,
      RZJME: -66156729,
      RQYE: 330052149.54,
      RZYEZB: 6.31411396,
    });
    assert.ok(row);
    assert.equal(row.id, "601318");
    assert.equal(row.rzye, 35559273800);
    assert.equal(row.rzjme, -66156729);
    assert.ok(Math.abs(row.ratio! - 6.31411396) < 1e-9);
  });

  it("代码带前缀/非法 → null", () => {
    assert.equal(parseMarginRow({ SCODE: "sh601318", RZYE: 1 }), null);
    assert.equal(parseMarginRow({ SCODE: "", RZYE: 1 }), null);
  });

  it("融资余额非正 → null（不编数字）", () => {
    assert.equal(parseMarginRow({ SCODE: "600000", RZYE: 0 }), null);
    assert.equal(parseMarginRow({ SCODE: "600000", RZYE: "abc" }), null);
  });

  it("RZYEZB 缺失 → ratio null（缺的样子就是缺，不拿 0 凑）", () => {
    const row = parseMarginRow({ SCODE: "600000", RZYE: 100, RZYEZB: null });
    assert.ok(row);
    assert.equal(row.ratio, null);
  });
});

describe("parseMarginPage", () => {
  it("按融资余额降序，坏行计数进 missing", () => {
    const { rows, missing } = parseMarginPage([
      { SCODE: "600001", RZYE: 100 },
      { SCODE: "bad", RZYE: 999 },
      { SCODE: "600002", RZYE: 300 },
    ]);
    assert.equal(missing, 1);
    assert.deepEqual(rows.map((r) => r.id), ["600002", "600001"]);
  });
});

describe("marginSummary", () => {
  it("总额换算成亿元，只数对得上", () => {
    const s = marginSummary({
      date: "2026-10-09",
      rows: [
        { id: "600001", name: "a", rzye: 2e8, rzjme: 1e8, rqye: 0, ratio: 3 },
        { id: "600002", name: "b", rzye: 3e8, rzjme: -1e8, rqye: 0, ratio: null },
      ],
    });
    assert.equal(s.totalRzyeYi, 5);
    assert.equal(s.totalRzjmeYi, 0);
    assert.equal(s.withRatio, 1);
  });
});
