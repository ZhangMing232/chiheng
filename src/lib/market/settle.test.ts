/**
 * 这个文件是干什么的：
 * 钉住结算判定的三种结局——成交 / 还没到时候 / 真卡住。
 *
 * 为什么值得钉：「还没到卖出日」和「真卡住」早年是一句话报出去的，
 * 结果每次拿几十笔正常持仓刷一条「会一直挂着」的假警报。这里把它们分开断言，
 * 谁敢再合并算，测试会先挂。
 *
 * 你需要知道的：
 * - 每根 K 线用 flat 造（开高低收同一个价），需要触发哪边再用 mutate 改
 * - exitFill 的完整规矩在 journal-book.test.ts，这里只测「判定分到哪一类」
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isStuck, settleOne } from "@/lib/market/settle";
import type { Bar } from "@/lib/market/types";

const ENTRY = "2026-03-02";
const pad = (n: number) => String(n).padStart(2, "0");
const flat = (date: string, c: number): Bar => ({ date, o: c, c, h: c, l: c, v: 100 });

/** 买入日之后 n 根 K 线，默认全是平盘。 */
function bars(n: number, mutate?: (i: number, bar: Bar) => Bar): Bar[] {
  const out: Bar[] = [flat(ENTRY, 10)];
  for (let i = 1; i <= n; i += 1) {
    const bar = flat(`2026-03-${pad(2 + i)}`, 10);
    out.push(mutate ? mutate(i, bar) : bar);
  }
  return out;
}

const base = { id: "sh600519", name: "贵州茅台", dayDate: ENTRY, entry: 10, stop: 9, target: 12, hold: 8 };

test("拿满 8 个交易日按到期收盘价成交", () => {
  const verdict = settleOne({ ...base, bars: bars(14) });
  assert.deepEqual(verdict, { kind: "filled", price: 10, date: "2026-03-10", reason: "time" });
});

test("中途跌破止损按止损成交", () => {
  const verdict = settleOne({ ...base, bars: bars(14, (i, bar) => (i === 3 ? { ...bar, c: 9.1, l: 8.8, h: 9.5, o: 9.3 } : bar)) });
  assert.deepEqual(verdict, { kind: "filled", price: 9, date: "2026-03-05", reason: "stop" });
});

test("还没到卖出日是正常状态，不算卡住", () => {
  // 09-30 建的仓今天才 3 个交易日——早年这类全被报成「会一直挂着」
  const verdict = settleOne({ ...base, bars: bars(3) });
  assert.deepEqual(verdict, { kind: "waiting", passed: 3 });
  assert.equal(isStuck(verdict), false);
});

test("买入日不在 K 线窗口里才是真卡住，要说清最早哪天", () => {
  const list = bars(14).filter((bar) => bar.date !== ENTRY);
  const verdict = settleOne({ ...base, bars: list });
  assert.equal(verdict.kind, "stuck-no-buy-day");
  assert.equal(isStuck(verdict), true);
  assert.match(verdict.kind === "stuck-no-buy-day" ? verdict.reason : "", /最早 2026-03-03/);
});

test("过了持有天数仍算不出来也算卡住，要说清过了几天", () => {
  // 接口吐出一串全 0 的残缺 K 线时，exitFill 一路 continue，最后交不出价
  const list = bars(14, (_i, bar) => ({ ...bar, o: 0, c: 0, h: 0, l: 0 }));
  const verdict = settleOne({ ...base, bars: list });
  assert.equal(verdict.kind, "stuck-overdue");
  assert.match(verdict.kind === "stuck-overdue" ? verdict.reason : "", /已过 14 个交易日/);
});

test("老账本没存止损止盈，用规则现推而不是崩掉", () => {
  // 默认规则：止损 4.5% → 9.55；止盈取整段区间 → 11.5。
  // 开盘价 9.6 在止损之上（不是跳空），所以成交在止损价而不是开盘价。
  const verdict = settleOne({
    ...base,
    stop: null,
    target: null,
    bars: bars(14, (i, bar) => (i === 3 ? { ...bar, c: 9.5, l: 9.4, h: 9.7, o: 9.6 } : bar)),
  });
  assert.deepEqual(verdict, { kind: "filled", price: 9.55, date: "2026-03-05", reason: "stop" });
});

test("持有天数由调用方给，次日补涨这种 1 天就到期", () => {
  const verdict = settleOne({ ...base, hold: 1, bars: bars(14) });
  assert.deepEqual(verdict, { kind: "filled", price: 10, date: "2026-03-03", reason: "time" });
});
