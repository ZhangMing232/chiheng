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
import { dayReliable, dayReturns, exitFill, liveGate, losingStreak, nthClose, recentMean } from "@/lib/market/journal-book";

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

test("盘中记下的那天可以拿来统计", () => {
  assert.equal(dayReliable({ signalTime: "09:30" }), true);
  assert.equal(dayReliable({ signalTime: "14:50" }), true);
});

test("收盘之后补记的那天不算数", () => {
  assert.equal(dayReliable({ signalTime: "15:00" }), false);
  assert.equal(dayReliable({ signalTime: "23:48" }), false);
});

test("没有 signalTime 的老数据不擅自丢掉", () => {
  assert.equal(dayReliable({}), true);
  assert.equal(dayReliable({ signalTime: "" }), true);
});

/**
 * 下面这几条守的是「账上记的亏损不能少于真实亏损」。
 * 曾经有两处把大亏记成了小亏：一是宽限期最后一天遇到跌停封死，拿止损价冒充成交价；
 * 二是跳空穿越止损（除权、复牌、突发利空）时按止损价成交——那天开盘就跌穿了，
 * 止损单根本成交不到那个价。两边都会让风险看起来比实际小得多。
 */

type OBar = { date: string; o?: number; h?: number; l?: number; c: number };

/** 连着跌停的 K 线：每天开盘即最低，等于封死卖不掉。 */
function sealedDownBars(count: number): OBar[] {
  const out: OBar[] = [{ date: ENTRY, o: 10, h: 10, l: 10, c: 10 }];
  let price = 10;
  for (let i = 1; i <= count; i += 1) {
    price = Math.round(price * 0.9 * 100) / 100;
    const date = `2026-03-${pad(2 + i)}`;
    out.push({ date, o: price, h: price, l: price, c: price });
  }
  return out;
}

test("宽限期最后一天仍封着，按当天收盘价结，不能拿止损价顶替", () => {
  const result = exitFill(sealedDownBars(20), ENTRY, 10, 9.7, 11.5, 10, 8);
  assert.equal(result?.reason, "time");
  // 那天真实收盘是 2.54（-74.6%）。记成 9.7 的话，一笔腰斩的仓位只显示亏 3%。
  assert.ok(result && result.price < 3, `应当按收盘价结，实际 ${result?.price}`);
  assert.ok(result && result.price < 9.7, "不能按止损价成交");
});

test("跳空低开穿过止损，按开盘价成交，不是止损价", () => {
  // 除权除息后的首个交易日，开盘直接到 5 元，止损单不可能成交在 9.7。
  const rows: OBar[] = [
    { date: ENTRY, o: 10, h: 10, l: 10, c: 10 },
    { date: "2026-03-03", o: 10.1, h: 10.3, l: 9.9, c: 10.1 },
    { date: "2026-03-04", o: 5, h: 5.1, l: 4.9, c: 5 },
  ];
  const result = exitFill(rows, ENTRY, 10, 9.7, 11.5, 10, 8);
  assert.deepEqual(result, { date: "2026-03-04", price: 5, reason: "stop" });
});

test("开盘在止损之上、盘中才跌破，仍按止损价成交", () => {
  const rows: OBar[] = [
    { date: ENTRY, o: 10, h: 10, l: 10, c: 10 },
    { date: "2026-03-03", o: 10.1, h: 10.2, l: 9.5, c: 9.6 },
  ];
  assert.deepEqual(exitFill(rows, ENTRY, 10, 9.7, 11.5, 10, 8), {
    date: "2026-03-03",
    price: 9.7,
    reason: "stop",
  });
});

test("没给开盘价时退回原来的算法，不会因为加了字段就变脸", () => {
  const rows: { date: string; h?: number; l?: number; c: number }[] = [
    { date: ENTRY, h: 10, l: 10, c: 10 },
    { date: "2026-03-03", h: 10.2, l: 9.5, c: 9.6 },
  ];
  assert.deepEqual(exitFill(rows, ENTRY, 10, 9.7, 11.5, 10, 8), {
    date: "2026-03-03",
    price: 9.7,
    reason: "stop",
  });
});

test("跌幅超过跌停板的暴跌不会被误判成跌停封死", () => {
  // 跌停最多跌 limitPct。跌得比这多，一定是除权或复牌，那天照样能卖。
  const rows: OBar[] = [
    { date: ENTRY, o: 10, h: 10, l: 10, c: 10 },
    { date: "2026-03-03", o: 5, h: 5.1, l: 4.9, c: 5 },
    { date: "2026-03-04", o: 5.1, h: 5.2, l: 5, c: 5.1 },
  ];
  // 跳空当天就该成交，不能被当成「封死卖不掉」顺延到后面。
  assert.equal(exitFill(rows, ENTRY, 10, 9.7, 11.5, 10, 8)?.date, "2026-03-03");
});

const GATE = { minDays: 0, minClosed: 0, maxDrawdownPct: 8, maxLosingStreak: 3 };
const win = 0.01;
const lose = -0.01;
/** 每天一笔，date 依次往后排。 */
const eachDay = (values: number[]) => values.map((ret, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, ret }));

test("同一天亏好几笔，只算一天", () => {
  // 一天里三笔都是亏的，但那是同一天的行情，不能数成连亏三天
  const sameDay = [
    { date: "2026-01-01", ret: lose },
    { date: "2026-01-01", ret: lose },
    { date: "2026-01-01", ret: lose },
  ];
  assert.deepEqual(dayReturns(sameDay), [-0.01]);
  assert.equal(losingStreak(dayReturns(sameDay)), 1);
});

test("连亏几天算反常，要看这套策略平时亏多少天", () => {
  // 四成交易日是亏的，连亏 3 天是常事，不该拦
  const choppy = eachDay([
    ...Array.from({ length: 6 }, () => win), ...Array.from({ length: 3 }, () => lose),
    ...Array.from({ length: 6 }, () => win), ...Array.from({ length: 3 }, () => lose),
    win, lose, lose, lose,
  ]);
  assert.equal(liveGate(0, [], choppy, GATE).ok, true);
  // 亏的日子只有两成四，连亏 3 天就反常了
  const mostly = eachDay([
    ...Array.from({ length: 10 }, () => win), ...Array.from({ length: 2 }, () => lose),
    ...Array.from({ length: 8 }, () => win), lose, win, lose, lose, lose,
  ]);
  assert.equal(liveGate(0, [], mostly, GATE).ok, false);
});

test("最近 20 笔平均亏过 8% 才停手", () => {
  // 亏一天、赚一天交替，连亏天数只有 1，卡不住的只能是「最近 20 笔均值」这条。
  // 每天两笔，亏日跌 loss、赚日涨 0.10，30 天共 60 笔，看最后 20 笔。
  const zigzag = (loss: number) =>
    eachDay(
      Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? [loss, loss] : [0.1, 0.1])).flat(),
    );
  // 最后 20 笔平均 -5%，还没到 8% 那条线
  assert.equal(liveGate(0, [], zigzag(-0.1), GATE).ok, true);
  // 最后 20 笔平均 -10%，该停
  assert.equal(liveGate(0, [], zigzag(-0.3), GATE).ok, false);
});

test("最近 20 笔的均值只取最后 20 笔", () => {
  const list = [...Array.from({ length: 30 }, () => 0.01), ...Array.from({ length: 20 }, () => -0.05)];
  assert.ok(Math.abs(recentMean(list, 20)! + 0.05) < 1e-9, String(recentMean(list, 20)));
  // 不足 20 笔不给结论，免得刚开张就被拦
  assert.equal(recentMean([win, lose], 20), null);
});
