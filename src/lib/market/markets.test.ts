/**
 * 这个文件是干什么的：
 * 钉住多市场规则配置表（M1/M2）——前缀路由、货币、涨跌停、交易制度。
 * A 股行为必须逐点不变（boardLimit 的现有测试在 model.test.ts），这里只管港美差异。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { currencyLabelOf, ID_PATTERN, MARKETS, marketOf, marketSpecOf } from "@/lib/market/markets";

test("marketOf：按前缀路由，认不出的归 A 股", () => {
  assert.equal(marketOf("sh600519"), "a");
  assert.equal(marketOf("sz300750"), "a");
  assert.equal(marketOf("bj430047"), "a");
  assert.equal(marketOf("hk00700"), "hk");
  assert.equal(marketOf("usAAPL"), "us");
  assert.equal(marketOf("usBRK-B"), "us");
});

test("港美规则差异：T+0、无涨跌停、币种、时区", () => {
  assert.equal(marketSpecOf("hk00700").settlement, "T+0");
  assert.equal(marketSpecOf("usAAPL").settlement, "T+0");
  assert.equal(marketSpecOf("sh600519").settlement, "T+1");
  assert.equal(marketSpecOf("hk00700").limit, "none");
  assert.equal(marketSpecOf("usAAPL").limit, "none");
  assert.equal(marketSpecOf("sh600519").limit, "board");
  assert.equal(marketSpecOf("hk00700").currency, "HKD");
  assert.equal(marketSpecOf("usAAPL").currency, "USD");
  assert.equal(marketSpecOf("sh600519").currency, "CNY");
  assert.equal(marketSpecOf("usAAPL").timezone, "America/New_York");
  // 每个市场都有完整配置，漏字段 TS 会直接报
  for (const spec of Object.values(MARKETS)) {
    assert.ok(spec.currencyLabel && spec.label && spec.openMin > 0 && spec.closeMin > spec.openMin);
  }
});

test("currencyLabelOf：价格单位跟市场走", () => {
  assert.equal(currencyLabelOf("hk00700"), "港元");
  assert.equal(currencyLabelOf("usAAPL"), "美元");
  assert.equal(currencyLabelOf("sh600519"), "元");
});

test("ID_PATTERN：三种市场的合法形状，非法形状拒掉", () => {
  for (const ok of ["sh600519", "sz300750", "bj430047", "hk00700", "usAAPL", "usBRK-B"]) {
    assert.ok(ID_PATTERN.test(ok), `${ok} 应该合法`);
  }
  for (const bad of ["600519", "hk0700", "hk007000", "usaapl", "usAAPLAPPLE", "sh6005190", "us00700", "xx600519"]) {
    assert.ok(!ID_PATTERN.test(bad), `${bad} 应该非法`);
  }
});
