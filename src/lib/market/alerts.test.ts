/**
 * 这个文件是干什么的：
 * 钉住告警的三条纪律——**只推应验的、24 小时去重、失败不产假告警**。
 *
 * 「只推应验的」最重要：把「还没触发」也推，一天 N 条全是日常状态，
 * 三天后就没人看了——告警的价值全在「稀少且真」。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { alertId, alertsFromChecks, failureAlert, inQuietHours, mergeAlerts, trimInbox } from "@/lib/market/alerts";
import type { PointCheck } from "@/lib/market/knowledge";

function check(object: string, status: PointCheck["status"], detail = "细节"): PointCheck {
  return { point: { object, threshold: "阈值", source: "来源", nextAt: "时点", effect: "后果", from: "price" }, status, detail };
}

const NOW = new Date("2026-10-13T15:00:00+08:00");

test("只把「已应验」转成告警", () => {
  const alerts = alertsFromChecks("600519", "贵州茅台", [check("近 20 日涨幅", "triggered"), check("主力净流入", "watching"), check("否决公告", "cannot-check")], NOW);
  assert.equal(alerts.length, 1, "watching 和 cannot-check 都不推");
  assert.match(alerts[0]!.title, /预警应验了/);
});

test("同一天同一只票同一预警只报一次（id 去重）", () => {
  const id1 = alertId("600519", "近 20 日涨幅", "2026-10-13");
  const id2 = alertId("600519", "近 20 日涨幅", "2026-10-13");
  assert.equal(id1, id2);
  const alerts = alertsFromChecks("600519", "贵州茅台", [check("近 20 日涨幅", "triggered")], NOW);
  const merged = mergeAlerts(alerts, alerts);
  assert.equal(merged.length, 1);
});

test("不同预警各报各的", () => {
  const alerts = alertsFromChecks("600519", "贵州茅台", [check("近 20 日涨幅", "triggered"), check("分位档位", "triggered")], NOW);
  assert.equal(alerts.length, 2);
  assert.notEqual(alerts[0]!.id, alerts[1]!.id);
});

test("mergeAlerts 同 id 保留最新（重跑不重复堆）", () => {
  const a1 = { ...alertsFromChecks("600519", "茅台", [check("涨幅", "triggered")], NOW)[0]!, detail: "旧细节" };
  const a2 = { ...a1, detail: "新细节", at: "2026-10-13T16:00:00+08:00" };
  const merged = mergeAlerts([a1], [a2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.detail, "新细节");
});

test("研判失败产「今天没跑成」说明，不产假告警", () => {
  const a = failureAlert("600519", "贵州茅台", "行情接口超时", NOW);
  assert.equal(a.kind, "failed");
  assert.match(a.title, /今天没研判成/);
  assert.match(a.detail, /超时/, "原因要具体");
});

test("静默时段：半夜不推", () => {
  assert.equal(inQuietHours(new Date("2026-10-13T02:00:00+08:00")), true);
  assert.equal(inQuietHours(new Date("2026-10-13T14:00:00+08:00")), false);
  assert.equal(inQuietHours(new Date("2026-10-13T23:30:00+08:00")), true);
});

test("收件箱有上限，超了砍最旧的", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `id-${i}`, symbol: "600519", name: "茅台", kind: "triggered" as const,
    title: "t", detail: "d", at: `2026-10-13T${String(i % 24).padStart(2, "0")}:00:00+08:00`, source: "s",
  }));
  assert.equal(trimInbox(many).length, 200);
});

test("告警文案不含投资动作（红线照样过）", () => {
  const alerts = alertsFromChecks("600519", "茅台", [check("涨幅", "triggered", "方向变了，该考虑卖出")], NOW);
  for (const a of alerts) {
    // 注意：detail 来自核对结果，是事实描述；标题是模板。模板不许有动作词
    assert.ok(!/(建议|应该|可以|加仓|减仓|目标价|止损)/.test(a.title), `标题出现动作词：${a.title}`);
  }
});
