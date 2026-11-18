import { test } from "node:test";
import assert from "node:assert/strict";
import { boardOf, canTrade, tradableAccounts } from "./account-rules.ts";

test("板块识别：688→科创、300/301→创业、8/4/92→北交、其余→主板", () => {
  assert.equal(boardOf("sh688183"), "star"); // 生益电子
  assert.equal(boardOf("sz300767"), "chinext"); // 震安科技
  assert.equal(boardOf("sh603127"), "main"); // 昭衍新药
  assert.equal(boardOf("bj830799"), "bse");
  assert.equal(boardOf("sz002242"), "main"); // 九阳 深主板
});

test("🔴 科创板只有国泰海通能买", () => {
  assert.equal(canTrade("国泰海通", "sh688183"), true);
  assert.equal(canTrade("东莞证券", "sh688183"), false);
  assert.equal(canTrade("广发证券", "sh688183"), false);
});

test("北交所只有国泰海通能买", () => {
  assert.equal(canTrade("国泰海通", "bj830799"), true);
  assert.equal(canTrade("东莞证券", "bj830799"), false);
});

test("创业板三个账户都能买", () => {
  assert.equal(canTrade("东莞证券", "sz300767"), true);
  assert.equal(canTrade("广发证券", "sz300767"), true);
});

test("主板三个账户都能买", () => {
  assert.equal(canTrade("东莞证券", "sh603127"), true);
});

test("tradableAccounts 返回可交易账户列表", () => {
  assert.deepEqual(tradableAccounts("sh688183"), ["国泰海通"]);
  assert.deepEqual(tradableAccounts("sh603127"), ["国泰海通", "东莞证券", "广发证券"]);
});
