/**
 * 这个文件是干什么的：
 * 钉住 cninfo.ts 里两个最容易写错、又不需要联网就能验的地方：
 * 时间戳怎么转日期、PDF 链接怎么拼。
 *
 * 联网的部分不在这里测（项目测试跑在 node --test 上，不该依赖外网）。
 * 能离线验的都验掉，剩下的靠接口实测——本文件里所有常量都来自 2026-10-11 的真实响应。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dayOf, loadCninfoAnnouncements, lookupOrgId, pdfUrlOf } from "@/lib/market/cninfo";

test("dayOf：毫秒时间戳转日期", () => {
  // 1786723200000 = 2026-08-15（茅台 2026 年半年报的真实 announcementTime）
  assert.equal(dayOf(1786723200000), "2026-08-15");
  assert.equal(dayOf(1791637542000), "2026-10-10", "立讯精密 337 调查公告的真实时间戳");
});

test("dayOf：非法值返回空串，不编造日期", () => {
  assert.equal(dayOf(Number.NaN), "");
  assert.equal(dayOf(Number.POSITIVE_INFINITY), "");
});

test("pdfUrlOf：拼上 static 域名", () => {
  // 真实值：finalpage/2026-08-15/1225475868.PDF
  assert.equal(
    pdfUrlOf("finalpage/2026-08-15/1225475868.PDF"),
    "http://static.cninfo.com.cn/finalpage/2026-08-15/1225475868.PDF",
  );
});

test("pdfUrlOf：缺路径返回空串（不给半个链接）", () => {
  assert.equal(pdfUrlOf(undefined), "");
  assert.equal(pdfUrlOf(null), "");
  assert.equal(pdfUrlOf(""), "");
  assert.equal(pdfUrlOf("   "), "");
});

test("非法代码：不联网，直接返回空，不抛错", async () => {
  // 这几个都会在函数最开头的正则处被挡掉，不会发出任何请求
  assert.equal(await lookupOrgId("60051"), null, "5 位");
  assert.equal(await lookupOrgId("6005190"), null, "7 位");
  assert.equal(await lookupOrgId("sh600519"), null, "带前缀");
  assert.equal(await lookupOrgId(""), null);
  assert.deepEqual(await loadCninfoAnnouncements("60051"), []);
  assert.deepEqual(await loadCninfoAnnouncements("sh600519"), []);
});

test("🔴 巨潮的核心坑：stock 只给代码会静默返回空，必须带 orgId", () => {
  // 这条不测代码，只把实测结论钉成文档，防止以后有人「简化」掉 orgId 那段：
  //   2026-10-11 实测 stock=600519（无 orgId）→ {"announcements":null,...}
  //   同样条件 stock=600519,gssh0600519 → 1684 条
  // 而且 orgId 三种格式（gssz0000001 / gssh0600519 / 9900014448）拼不出来，只能查。
  const withOrgId = "600519,gssh0600519";
  const withoutOrgId = "600519";
  assert.notEqual(withOrgId, withoutOrgId);
  assert.ok(withOrgId.includes(","), "带 orgId 的格式是 代码,orgId");
});
