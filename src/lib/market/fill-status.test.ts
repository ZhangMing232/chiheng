/**
 * fill-status.ts 的测试：四态判定的每条分支都要钉住。
 * 重点防回归：停牌不许再被读成「待开盘」（2026-11-16 天普股份实例）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeFill, buyFilledOf, fillStatusTone, FILL_STATUS_LABEL, type DayEvidence } from "./fill-status.ts";

const base: DayEvidence = { bar: null, snapshotVolume: null, afterOpen: false, afterClose: false, limitUpPrice: null };

test("有正常 bar → filled，无 note", () => {
  const v = judgeFill({ ...base, afterOpen: true, bar: { o: 10, c: 10.5, h: 10.8, l: 9.9 }, limitUpPrice: 11 });
  assert.equal(v.status, "filled");
  assert.equal(v.note, null);
});

test("一字涨停：开盘=涨停=最低 → unfillable，note 带价格", () => {
  const v = judgeFill({ ...base, afterOpen: true, bar: { o: 11, c: 11, h: 11, l: 11 }, limitUpPrice: 11 });
  assert.equal(v.status, "unfillable");
  assert.ok(v.note?.includes("11.00"));
  assert.ok(v.note?.includes("一字涨停"));
});

test("开盘涨停但盘中开板（最低 < 涨停）→ filled + 说明", () => {
  const v = judgeFill({ ...base, afterOpen: true, bar: { o: 11, c: 10.8, h: 11, l: 10.5 }, limitUpPrice: 11 });
  assert.equal(v.status, "filled");
  assert.ok(v.note?.includes("开板"));
});

test("🔴 停牌：无 bar 但快照成交量为 0 → suspended（不许再显示待开盘）", () => {
  const v = judgeFill({ ...base, afterOpen: true, snapshotVolume: 0 });
  assert.equal(v.status, "suspended");
  assert.ok(v.note?.includes("停牌"));
  assert.notEqual(FILL_STATUS_LABEL[v.status], "待开盘");
});

test("🔴 停牌发生在开盘前也算停牌（成交量 0 是硬证据，和时间无关）", () => {
  const v = judgeFill({ ...base, afterOpen: false, snapshotVolume: 0 });
  assert.equal(v.status, "suspended");
});

test("9:30 前、什么数据都没有 → pending（这才是真正的待开盘）", () => {
  const v = judgeFill({ ...base, afterOpen: false, afterClose: false });
  assert.equal(v.status, "pending");
  assert.equal(v.note, null);
});

test("已开盘、K 线和快照都没有 → missing（真缺失，不是还没到）", () => {
  const v = judgeFill({ ...base, afterOpen: true, afterClose: false });
  assert.equal(v.status, "missing");
  assert.ok(v.note?.includes("数据源"));
});

test("收盘后仍没数据 → missing（不能再说还没到）", () => {
  const v = judgeFill({ ...base, afterOpen: true, afterClose: true });
  assert.equal(v.status, "missing");
});

test("有成交量却没有日 K bar → missing（接口异常，不误判停牌）", () => {
  const v = judgeFill({ ...base, afterOpen: true, snapshotVolume: 123456 });
  assert.equal(v.status, "missing");
  assert.ok(v.note?.includes("日 K"));
});

test("buyFilledOf：filled=true，unfillable/suspended=false，pending/missing=null（兼容旧三值）", () => {
  assert.equal(buyFilledOf("filled"), true);
  assert.equal(buyFilledOf("unfillable"), false);
  assert.equal(buyFilledOf("suspended"), false);
  assert.equal(buyFilledOf("pending"), null);
  assert.equal(buyFilledOf("missing"), null);
});

test("fillStatusTone：只有 filled 是 ok，pending 是 wait，其余都是 no", () => {
  assert.equal(fillStatusTone("filled"), "ok");
  assert.equal(fillStatusTone("pending"), "wait");
  assert.equal(fillStatusTone("unfillable"), "no");
  assert.equal(fillStatusTone("suspended"), "no");
  assert.equal(fillStatusTone("missing"), "no");
});

test("FILL_STATUS_LABEL：五态文案各不相同、无遗漏", () => {
  const labels = Object.values(FILL_STATUS_LABEL);
  assert.equal(labels.length, 5);
  assert.equal(new Set(labels).size, 5, "文案不能重复");
  assert.equal(FILL_STATUS_LABEL.suspended, "停牌·买不进");
  assert.equal(FILL_STATUS_LABEL.missing, "数据缺失");
});

test("bar 的 o<=0 视为无效（当没 bar 处理）", () => {
  const v = judgeFill({ ...base, afterOpen: true, bar: { o: 0, c: 0, h: 0, l: 0 }, snapshotVolume: 0 });
  assert.equal(v.status, "suspended");
});
