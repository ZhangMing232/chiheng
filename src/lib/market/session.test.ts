/**
 * 这个文件是干什么的：
 * 钉住「今天这根日线定型了吗」这条判断（dayBarReady）。
 *
 * 为什么值得单测：它是结算闸的开关。判早了会拿盘中现价冒充收盘价
 * （2026-10-28 查账实测 10 笔偏了 1.05%~10.02%），判晚了会白白拖一天。
 * 而且它必须按**上海时间**算，不能用本机时区——这台机器可能不在东八区。
 *
 * 你需要知道的：
 * - A 股 15:00 收盘集合竞价结束才产生收盘价，所以 15:00 之后用当天收盘价结账
 *   是合规的；这里多留 5 分钟是因为行情接口把今天这根写进日线有延迟。
 * - 休市日恒 true：今天本来就没有这根 K 线。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_BAR_READY_MINUTES, dayBarReady, isTradingDay } from "@/lib/market/session";

/** 用带 +08:00 的字面量造时刻，不受本机时区影响。 */
const at = (iso: string): number => Date.parse(`${iso}+08:00`);

test("交易日 15:00 之前：今天这根日线还没定型", () => {
  assert.equal(dayBarReady(at("2026-03-10T09:30:00")), false);
  assert.equal(dayBarReady(at("2026-03-10T14:59:00")), false);
  // 刚过收盘那几分钟也不能信——接口还没把收盘价写进去
  assert.equal(dayBarReady(at("2026-03-10T15:00:00")), false);
  assert.equal(dayBarReady(at("2026-03-10T15:04:00")), false);
});

test("交易日收盘 + 缓冲之后：定型了，可以按当天收盘价结算", () => {
  assert.equal(dayBarReady(at("2026-03-10T15:05:00")), true);
  assert.equal(dayBarReady(at("2026-03-10T20:00:00")), true);
});

test("休市日恒 true：今天没有这根 K 线，谈不上定型", () => {
  // 2026-03-14 是周六
  assert.equal(isTradingDay("2026-03-14"), false);
  assert.equal(dayBarReady(at("2026-03-14T10:00:00")), true);
});

test("缓冲就是 5 分钟，写死在这里方便改的时候看见影响面", () => {
  assert.equal(DAY_BAR_READY_MINUTES, 15 * 60 + 5);
});
