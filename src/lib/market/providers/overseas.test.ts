/**
 * 这个文件是干什么的：
 * 钉住港美股 provider 的解析层——secid 映射、K 线七段格式、联想结果筛选。
 * 格式全是 2026-10-12 实测东财接口的真实返回（见 registry traps）。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseKlineRow, parseKlines, parseQuote, parseSuggest, secidOf } from "@/lib/market/providers/overseas";

test("secidOf：hk→116、us→105、A 股返回 null", () => {
  assert.equal(secidOf("hk00700"), "116.00700");
  assert.equal(secidOf("usAAPL"), "105.AAPL");
  assert.equal(secidOf("usBRK-B"), "105.BRK-B");
  assert.equal(secidOf("sh600519"), null);
});

test("parseKlineRow：七段「日期,开,收,高,低,量,额」，开收在高前", () => {
  // 实测东财港股返回：日期,开,收,高,低（和腾讯 qfqday 的开收高低顺序不同，别照搬）
  const bar = parseKlineRow("2026-10-12,428.400,425.800,430.400,423.400,14011738,5983558144.000");
  assert.deepEqual(bar, { date: "2026-10-12", o: 428.4, c: 425.8, h: 430.4, l: 423.4, v: 14011738 });
  assert.equal(parseKlineRow("缺字段"), null);
  assert.equal(parseKlineRow("2026-10-12,abc,425.8,430.4,423.4,1,2"), null);
});

test("parseQuote：用昨收算涨跌幅，名称缺失返回 null", () => {
  const data = {
    name: "腾讯控股",
    preKPrice: 424.8,
    klines: ["2026-10-12,428.400,425.800,430.400,423.400,14011738,5983558144.000"],
  };
  const quote = parseQuote("hk00700", data);
  assert.equal(quote?.name, "腾讯控股");
  assert.equal(quote?.price, 425.8);
  // (425.8 - 424.8) / 424.8 * 100 ≈ 0.24，与实测 stock/get f170=24（0.24%）吻合
  assert.ok(quote?.chg != null && Math.abs(quote.chg - 0.24) < 0.01, `chg=${quote?.chg}`);
  assert.equal(quote?.asOf, "2026-10-12");
  assert.equal(parseQuote("hk00700", { name: "", klines: data.klines }), null);
  assert.equal(parseQuote("hk00700", null), null);
});

test("parseKlines：坏行丢掉，顺序不动", () => {
  const rows = parseKlines(["2026-10-09,415.000,424.800,425.800,414.800,1,2", "坏行", "2026-10-12,428.400,425.800,430.400,423.400,1,2"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.date, "2026-10-12");
});

test("parseSuggest：只留港美正股，债券/涡轮丢", () => {
  // 实测返回形状：AAPL 正股 SecurityType=20，Apple Notes 债券 SecurityType=7
  const raw = {
    QuotationCodeTable: {
      Data: [
        { Code: "00700", Name: "腾讯控股", MktNum: "116", SecurityType: "19" },
        { Code: "80700", Name: "腾讯控股-R", MktNum: "116", SecurityType: "6" },
        { Code: "AAPL", Name: "苹果", MktNum: "105", SecurityType: "20" },
        { Code: "AAPL22", Name: "Apple Inc Notes 2022", MktNum: "105", SecurityType: "7" },
      ],
    },
  };
  const hits = parseSuggest(raw);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["hk00700", "usAAPL"],
  );
  assert.deepEqual(parseSuggest({}), []);
});
