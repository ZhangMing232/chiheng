/**
 * 这个文件是干什么的：
 * 守住到期卖出。到期的那天如果跌停封死、或者收盘价缺失，要顺延到后面能卖的那天，
 * 不能让这笔永远挂在账上——占着名额，也永远算不进胜率。
 *
 * 你需要知道的：
 * 买入当天不能卖（T+1）；同一天既碰到止损又碰到卖出价，按止损算。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { exitFill, nthClose } from "@/lib/market/journal-book";

type Bar = { date: string; h?: number; l?: number; c: number };

const flat = (date: string, c: number): Bar => ({ date, c, h: c, l: c });
const pad = (n: number) => String(n).padStart(2, "0");
const ENTRY = "2026-03-02";

/** 买入日之后 14 根 K 线，默认全是平盘，可用 mutate 改其中某几天。 */
function bars(mutate?: (i: number, bar: Bar) => Bar): Bar[] {
  const out: Bar[] = [flat(ENTRY, 10)];
  for (let i = 1; i <= 14; i += 1) {
    const bar = flat(`2026-03-${pad(2 + i)}`, 10);
    out.push(mutate ? mutate(i, bar) : bar);
  }
  return out;
}

const run = (list: Bar[]) => exitFill(list, ENTRY, 10, 9, 12, 10, 8);

test("正常持有 8 个交易日，第 8 天按收盘价卖出", () => {
  assert.deepEqual(run(bars()), { date: "2026-03-10", price: 10, reason: "time" });
});

test("到期那天跌停封死，顺延到下一个能卖的收盘价", () => {
  const result = run(bars((i, bar) => (i === 8 ? flat(bar.date, 9) : bar)));
  assert.equal(result?.reason, "time");
  assert.ok(result && result.date > "2026-03-10", "应当晚于到期日成交");
});

test("到期那天收盘价缺失，同样顺延，不会永久挂账", () => {
  const result = run(bars((i, bar) => (i === 8 ? { date: bar.date, c: 0, h: 0, l: 0 } : bar)));
  assert.equal(result?.reason, "time");
});

test("连续封板也能收尾，不会一直挂着", () => {
  const result = run(bars((i, bar) => (i >= 8 && i <= 12 ? flat(bar.date, 9) : bar)));
  assert.ok(result, "不能返回空");
});

test("中途跌破止损按止损成交", () => {
  assert.deepEqual(run(bars((i, bar) => (i === 3 ? { ...bar, c: 9.1, h: 9.5, l: 8.8 } : bar))), {
    date: "2026-03-05",
    price: 9,
    reason: "stop",
  });
});

test("中途到卖出价按卖出价成交", () => {
  assert.deepEqual(run(bars((i, bar) => (i === 3 ? flat(bar.date, 12.5) : bar))), {
    date: "2026-03-05",
    price: 12,
    reason: "target",
  });
});

test("买入当天就破止损也不算，满足 T+1", () => {
  const list = bars();
  list[0] = { date: ENTRY, c: 10, h: 10, l: 5 };
  assert.deepEqual(run(list), { date: "2026-03-10", price: 10, reason: "time" });
});

test("同一天两边都碰到，按止损算", () => {
  assert.deepEqual(run(bars((i, bar) => (i === 3 ? { date: bar.date, c: 10, h: 13, l: 8 } : bar))), {
    date: "2026-03-05",
    price: 9,
    reason: "stop",
  });
});

test("nthClose 数满交易日就用那天收盘价", () => {
  assert.deepEqual(nthClose(bars(), ENTRY), { date: "2026-03-10", price: 10 });
});
