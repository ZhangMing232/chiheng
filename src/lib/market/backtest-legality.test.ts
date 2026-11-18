/**
 * backtest-legality.ts 的测试：把「未来函数」和「T+1 违规」钉死。
 *
 * 这组测试的意义：2026-11-18 我写的两个回测都犯了这两个错，导致一个
 * 不存在的 +0.975pp 超额被当成真信号推给用户。规则必须由代码强制，
 * 不能靠写脚本的人记性好。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLegality, legalReturn, limitUpSealed, ROUND_TRIP_COST_PCT, type LegalBar } from "./backtest-legality.ts";

const bars: LegalBar[] = [
  { date: "2026-11-14", o: 10, h: 10.5, l: 9.8, c: 10.2 },
  { date: "2026-11-17", o: 10.4, h: 11, l: 10.3, c: 10.9 }, // 信号日
  { date: "2026-11-18", o: 11.2, h: 11.8, l: 11.1, c: 11.5 }, // T+1 买入日
  { date: "2026-11-19", o: 11.9, h: 12.2, l: 11.7, c: 12.0 }, // T+2 最早可卖
  { date: "2026-11-20", o: 12.1, h: 12.3, l: 11.9, c: 12.2 },
];

test("🔴 未来函数：信号日当天买入必须判非法", () => {
  const r = checkLegality("2026-11-17", bars[1], bars[3]); // 信号日买
  assert.equal(r.ok, false);
  assert.ok(r.why?.includes("未来函数"));
});

test("🔴 T+1 违规：当日买当日卖必须判非法", () => {
  const sameDay = { ...bars[2] };
  const r = checkLegality("2026-11-17", bars[2], sameDay);
  assert.equal(r.ok, false);
  assert.ok(r.why?.includes("T+1"));
});

test("合法：T+1 开盘买、T+2 卖", () => {
  const r = checkLegality("2026-11-17", bars[2], bars[3]);
  assert.equal(r.ok, true);
  assert.equal(r.why, null);
});

test("legalReturn：信号日收盘后 → 次日开盘买 → 再次日开盘卖", () => {
  const r = legalReturn("2026-11-17", bars, 1, "open");
  assert.ok("pct" in r && r.pct != null, "应该算出收益");
  if ("pct" in r && r.pct != null) {
    assert.equal(r.buyDate, "2026-11-18", "买入是信号日之后第一个交易日");
    assert.equal(r.sellDate, "2026-11-19", "卖出至少隔一天（T+1）");
    // 11.9 / 11.2 - 1
    assert.ok(Math.abs(r.pct - (11.9 / 11.2 - 1) * 100) < 1e-9);
  }
});

test("legalReturn：holdDays=0 也会被强制提高到 1（不许当日买卖）", () => {
  const r = legalReturn("2026-11-17", bars, 0, "open");
  assert.ok("pct" in r && r.pct != null);
  if ("pct" in r) assert.equal(r.sellDate, "2026-11-19", "holdDays=0 不能变成同日卖");
});

test("legalReturn：信号日之后没有数据 → 返回原因，不编收益", () => {
  const r = legalReturn("2026-11-20", bars, 1, "open");
  assert.ok("pct" in r && r.pct == null);
  if ("why" in r) assert.ok(r.why.length > 0);
});

test("limitUpSealed：一字涨停（开盘=最高=涨停）识别为买不进", () => {
  const oneWord: LegalBar = { date: "2026-11-18", o: 11, h: 11, l: 11, c: 11 };
  assert.equal(limitUpSealed(oneWord, 10), true, "昨收10→涨停11，全天封死");
  const opened: LegalBar = { date: "2026-11-18", o: 11, h: 11, l: 10.5, c: 10.9 };
  assert.equal(limitUpSealed(opened, 10), false, "开板过就能买");
});

test("回合成本常量存在且非零（回测必须扣）", () => {
  assert.ok(ROUND_TRIP_COST_PCT > 0);
});
