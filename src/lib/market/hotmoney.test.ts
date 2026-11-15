/**
 * hotmoney.ts 的纯函数测试：席位名归一与地名提取。
 * （pull() / loadHotMoney() 会联网，属集成路径，不在这里测。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortSeat, placeOf } from "./hotmoney.ts";

test("shortSeat：剥公司后缀、营业部/分公司归一", () => {
  assert.equal(shortSeat("华泰证券股份有限公司上海分公司"), "华泰证券上海分公司");
  assert.equal(shortSeat("中信证券股份有限公司北京望京证券营业部"), "中信证券北京望京");
});

test("shortSeat：空串不炸", () => {
  assert.equal(shortSeat(""), "");
});

test("placeOf：试验区 → 自贸区", () => {
  assert.equal(placeOf("上海自由贸易试验区营业部"), "自贸区");
});

test("placeOf：城市+路名提取", () => {
  const got = placeOf("国泰君安证券股份有限公司上海江苏路证券营业部");
  assert.ok(got.includes("江苏路"), `got: ${got}`);
});

test("placeOf：无路名时回退到短名尾部，不返回空", () => {
  const got = placeOf("某不知名证券营业部");
  assert.ok(got.length > 0);
});
