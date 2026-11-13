/**
 * 系统体检分层展示的守门测试（2026-11-14 第 11 轮）。
 *
 * 保护的核心纪律：**「出问题才看」不等于出问题时能藏起来。**
 * 8 项体检按 cadence 分三层，但 state=bad 的必须强制置顶常驻——
 * 如果 bad 项被折叠进「每周看」，等于把最该看到的东西藏起来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CADENCE_LABEL, type HealthCadence, type HealthRow } from "./settings.functions.ts";

const row = (label: string, state: HealthRow["state"], cadence: HealthCadence): HealthRow => ({
  label,
  state,
  cadence,
  detail: "d",
  fix: null,
});

/** 复刻页面的分组逻辑（页面里是内联 IIFE，这里独立实现以便单测）。 */
function groupForDisplay(rows: HealthRow[]) {
  const bad = rows.filter((h) => h.state === "bad");
  const rest = rows.filter((h) => h.state !== "bad");
  return {
    bad,
    daily: rest.filter((h) => h.cadence === "daily"),
    later: rest.filter((h) => h.cadence !== "daily"),
  };
}

test("🔴 bad 项必须置顶，哪怕它的 cadence 是 ondemand", () => {
  const rows = [
    row("记账心跳", "ok", "daily"),
    row("实盘vs回测", "bad", "ondemand"), // 原本折叠在「出问题才看」
    row("策略闸", "ok", "daily"),
  ];
  const g = groupForDisplay(rows);
  assert.equal(g.bad.length, 1);
  assert.equal(g.bad[0].label, "实盘vs回测", "bad 项要进第一组，不能被折叠藏起来");
  assert.equal(g.later.length, 0, "bad 项不该再出现在折叠组");
});

test("daily 组只放正常/注意的日频项", () => {
  const rows = [row("记账心跳", "ok", "daily"), row("策略闸", "warn", "daily"), row("规则回验", "ok", "weekly")];
  const g = groupForDisplay(rows);
  assert.deepEqual(g.daily.map((h) => h.label), ["记账心跳", "策略闸"]);
  assert.deepEqual(g.later.map((h) => h.label), ["规则回验"]);
});

test("折叠组含 weekly 与 ondemand，不丢项", () => {
  const rows = [row("规则回验", "ok", "weekly"), row("实盘vs回测", "warn", "ondemand")];
  const g = groupForDisplay(rows);
  assert.equal(g.later.length, 2);
  assert.equal(g.bad.length + g.daily.length + g.later.length, rows.length, "三条路加起来必须等于总数");
});

test("全部正常时，bad 组为空而不是造假", () => {
  const g = groupForDisplay([row("记账心跳", "ok", "daily")]);
  assert.equal(g.bad.length, 0);
});

test("cadence 三种都有中文标签", () => {
  assert.equal(CADENCE_LABEL.daily, "每天看");
  assert.equal(CADENCE_LABEL.weekly, "每周看");
  assert.equal(CADENCE_LABEL.ondemand, "出问题才看");
});
