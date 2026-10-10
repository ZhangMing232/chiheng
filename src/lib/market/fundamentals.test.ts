/** fundamentals 的测试：PIT 对齐是命脉，各种边界都要钉死。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pitValue, recentQuarters, type FundamentalRecord } from "./fundamentals.ts";

const rec = (ann: string, roe: number | null = 10): FundamentalRecord => ({ ann, roe, dtYoy: null, gm: null, debt: null });

test("取 t 日最新一条已披露的；还没披露的不许看（前视）", () => {
  const records = [rec("20260428", 8), rec("20260830", 12)];
  assert.equal(pitValue(records, "20260601")?.roe, 8); // 4 月披露的，8 月那份还没出
  assert.equal(pitValue(records, "20260830")?.roe, 12);
  assert.equal(pitValue(records, "20260901")?.roe, 12);
});

test("上市前 / 从未披露 → null，不是 0（0 会被读成「ROE=0 的烂公司」）", () => {
  assert.equal(pitValue([rec("20260428")], "20260101"), null);
  assert.equal(pitValue(undefined, "20260601"), null);
  assert.equal(pitValue([], "20260601"), null);
});

test("契约：records 必须按 ann 升序（fetch 脚本落盘时已排好），乱序是调用方 bug", () => {
  // 不测「乱序也能对上」——那要在 7 万次调用的热路径里每次重排。
  // 测的是正向契约：升序输入，线性扫到第一个未披露就停。
  const records = [rec("20260428", 8), rec("20260830", 12), rec("20261030", 20)];
  assert.equal(pitValue(records, "20260101"), null);
  assert.equal(pitValue(records, "20260601")?.roe, 8);
  assert.equal(pitValue(records, "20260915")?.roe, 12);
  assert.equal(pitValue(records, "20261231")?.roe, 20);
});

test("披露日当天的盘后能用——A 股财报是收盘后披露，t 日信号用的是 t 日收盘前已知信息，ann<=t 当天算已知", () => {
  // 这条是刻意记录口径：tushare 的 ann_date 是披露当天。收盘价决策在盘后，
  // 所以 ann == t 当天视为 t 日可用（pitValue 用 <= 就是钉这件事）。
  assert.equal(pitValue([rec("20260601", 15)], "20260601")?.roe, 15);
});

test("recentQuarters：连续跨年不断档，季度末日期格式正确", () => {
  const qs = recentQuarters(new Date(2026, 9, 10), 6); // 2026-10-10 → Q4 进行中
  assert.equal(qs[0], "20261231"); // Q4 期末是 12 月 31 日，不是 30
  assert.equal(qs[1], "20260930");
  assert.ok(qs.includes("20251231")); // 跨年不断档
  assert.equal(qs.length, 6);
  for (const q of qs) assert.match(q, /^\d{4}(0331|0630|0930|1231)$/);
});
