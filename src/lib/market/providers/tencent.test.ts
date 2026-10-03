/**
 * 这个文件是干什么的：
 * 守住科创板成交额的单位换算。
 *
 * 你需要知道的：
 * 主板榜单的成交额是万元，科创板榜单给的是元，差一万倍。不换算的话科创板
 * 每只票的成交额都像是几万亿，「突破要 8000 万」这类门槛对科创板形同虚设。
 * 实测键凯科技 688356：接口给 860539935，通达信同一天 860539904 元，即 86054 万元。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeStarRow } from "@/lib/market/providers/tencent";

test("科创板成交额从元换成万元", () => {
  const row = normalizeStarRow({ code: "sh688356", turnover: "860539935" });
  assert.equal(Number(row.turnover), 86053.9935);
});

test("泰诺麦博 688806 的成交额也按同样比例缩", () => {
  const row = normalizeStarRow({ code: "sh688806", turnover: "350550251" });
  assert.equal(Math.round(Number(row.turnover)), 35055);
});

test("解析不了的成交额原样返回，不补 0", () => {
  for (const bad of ["", "-", "abc"]) {
    const row = normalizeStarRow({ code: "sh688356", turnover: bad });
    assert.equal(row.turnover, bad);
  }
  assert.equal(normalizeStarRow({ code: "sh688356" }).turnover, undefined);
});

test("别的字段不受影响", () => {
  const row = normalizeStarRow({ code: "sh688356", turnover: "860539935", zsz: "64.54", lb: "1.20" });
  assert.equal(row.zsz, "64.54");
  assert.equal(row.lb, "1.20");
});
