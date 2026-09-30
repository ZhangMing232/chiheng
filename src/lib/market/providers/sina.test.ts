/**
 * 这个文件是干什么的：
 * 守住新浪行情源的字段换算：市值万元转亿元、成交额元转万元、板块判断、垃圾行过滤。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSinaQuote } from "@/lib/market/providers/sina";

test("新浪行解析：字段换算成内部形状", () => {
  const quote = parseSinaQuote({
    symbol: "sh600519",
    code: "600519",
    name: "贵州茅台",
    trade: "1500.00",
    changepercent: 1.23,
    settlement: "1482.00",
    open: "1490",
    high: "1510",
    low: "1485",
    per: 22.5,
    pb: 8.1,
    mktcap: "188000000",
    nmc: "188000000",
    turnoverratio: 0.32,
    amount: "4500000000",
    volume: 3000000,
  });
  assert.ok(quote);
  assert.equal(quote.id, "sh600519");
  assert.equal(quote.board, "sh");
  assert.equal(quote.price, 1500);
  assert.equal(quote.chg, 1.23);
  assert.equal(quote.cap, 18800);
  assert.equal(quote.floatCap, 18800);
  assert.equal(quote.amount, 450000);
  assert.equal(quote.turnover, 0.32);
  assert.equal(quote.volRatio, 0);
  assert.ok(quote.amp > 0);
  assert.equal(quote.d5, null);
  assert.equal(quote.st, false);
});

test("新浪行解析：北交所代码认得出，B 股挡掉", () => {
  const bj = parseSinaQuote({ symbol: "bj920000", code: "920000", name: "安徽凤凰", trade: "14.33", settlement: "14.25", high: "14.68", low: "14.21" });
  assert.equal(bj?.board, "bj");
  assert.equal(parseSinaQuote({ symbol: "sh900901", code: "900901", name: "B股", trade: "1.00" }), null);
});

test("新浪行解析：ST 标记和垃圾行", () => {
  const st = parseSinaQuote({ symbol: "sz000001", code: "000001", name: "ST测试", trade: "5.00" });
  assert.equal(st?.st, true);
  assert.equal(parseSinaQuote({}), null);
  assert.equal(parseSinaQuote({ symbol: "usAAPL", code: "AAPL", name: "苹果", trade: "200" }), null);
  assert.equal(parseSinaQuote({ symbol: "bad", name: "", trade: "0" }), null);
});
