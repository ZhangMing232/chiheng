/**
 * 这个文件是干什么的：
 * 钉住事件识别——**识别不了的不猜、一条只归一类**。
 *
 * 「不猜」这条最重要：把普通公告硬塞进某一类，算出来的「历史超额」就是假的，
 * 而且假得看不出来（样本数还变多了）。宁可少一类，不可错一类。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyArticle, classifyArticles, EVENT_KINDS } from "@/lib/market/event-rules";

test("业绩预告类标题能识别", () => {
  assert.equal(classifyArticle("2026年半年度业绩预告", "2026-07-15")?.label, "业绩预告");
  assert.equal(classifyArticle("关于2026年一季度业绩预增的公告", "2026-04-10")?.label, "业绩预告");
});

test("增减持分方向（一类标题两个方向）", () => {
  assert.equal(classifyArticle("关于持股5%以上股东减持股份计划的公告", "2026-05-01")?.direction, "减持");
  assert.equal(classifyArticle("控股股东增持股份计划", "2026-05-01")?.direction, "增持");
});

test("识别不了的返回 null，不硬塞", () => {
  assert.equal(classifyArticle("关于召开2026年第一次临时股东大会的通知", "2026-05-01"), null);
  assert.equal(classifyArticle("关于变更公司秘书的公告", "2026-05-01"), null);
});

test("一条只归一类：标题同时含「减持」和「回购」时取先命中的", () => {
  // 「减持股份暨回购股份进展」——减持在规则表里排前面，算减持
  const ev = classifyArticle("关于减持股份暨回购进展的公告", "2026-05-01");
  assert.equal(ev?.label, "重要股东减持");
});

test("批量：只认公告（kind=ann），非公告丢掉", () => {
  const rows = classifyArticles([
    { time: "2026-07-15T09:00", title: "2026年半年度业绩预告", kind: "ann" },
    { time: "2026-07-16T09:00", title: "某券商研报：买入评级", kind: "news" },
    { time: "2026-07-17T09:00", title: "关于变更监事的公告", kind: "ann" },
  ]);
  assert.equal(rows.length, 1, "研报不是事件、监事变更识别不了");
  assert.equal(rows[0]!.date, "2026-07-15", "日期取 time 的日期部分");
});

test("日期从 time 截前 10 位（带时分秒也行）", () => {
  const ev = classifyArticle("2026年半年度业绩预告", "2026-07-15T21:33:00");
  assert.equal(ev?.date, "2026-07-15");
});

test("事件类型清单覆盖它 A 股的 7 类", () => {
  assert.equal(EVENT_KINDS.length, 7);
  const labels = EVENT_KINDS.map((k) => k.label);
  for (const expect of ["业绩预告", "重要股东增持", "重要股东减持", "回购方案", "机构调研", "龙虎榜上榜", "限售解禁"]) {
    assert.ok(labels.includes(expect), `缺 ${expect}`);
  }
});
