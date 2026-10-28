/**
 * 守住实验台那句「还不能说」是怎么算出来的。
 *
 * 这个文件最容易出错的地方不是加减法，是**拿什么当样本**。
 * 三件事必须钉住：
 *
 * 1. 在拿的那一笔不能当成已结，更不能当成 0 分——0 会读成「不赚不亏」，
 *    而它的意思是还没有答案。平均收益的样本里一旦混进 60 个 0，
 *    胜率会被凭空拉平，界面看起来像稳的，其实什么也没测出来。
 * 2. 一笔都没卖出的那套策略，平均收益是 null（界面显示「—」），不是 0。
 * 3. 收盘后补记的那天不进统计，沿用 positions 页面的老规矩。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaperDay, PaperTrade } from "@/lib/paper";
import { buildLabReport, PER_STYLE_GOAL, styleName } from "@/lib/market/lab";
import { ROUND_TRIP_COST } from "@/lib/market/journal-book";
import { DEFAULT_RULES } from "@/lib/market/rules";

function trade(patch: Partial<PaperTrade> & { id: string; entry: number }): PaperTrade {
  return {
    code: patch.id,
    name: patch.id,
    style: patch.style ?? "early",
    exit: patch.exit ?? null,
    exitDate: patch.exitDate ?? null,
    ...patch,
  } as PaperTrade;
}

function day(patch: Partial<PaperDay> & { date: string; trades: PaperTrade[] }): PaperDay {
  return {
    savedAt: Date.parse(patch.date),
    signalTime: patch.signalTime ?? "09:31",
    indexEntry: patch.indexEntry ?? null,
    indexExit: patch.indexExit ?? null,
    ...patch,
  } as PaperDay;
}

test("在拿的一笔不算样本，收益率是 null 不是 0", () => {
  const report = buildLabReport(
    [day({ date: "2026-09-29", trades: [trade({ id: "a", entry: 10, style: "early" })] })],
    DEFAULT_RULES,
  );
  assert.equal(report.total, 1);
  assert.equal(report.closed, 0);
  assert.equal(report.open, 1);
  assert.equal(report.cells[0].ret, null);
  assert.equal(report.cells[0].open, true);
});

test("已卖的按扣费后的真实收益算，不按 0 记", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [trade({ id: "a", entry: 10, exit: 11, exitDate: "2026-09-30", style: "early" })],
      }),
    ],
    DEFAULT_RULES,
  );
  // netReturn 会扣一来一回的手续费（ROUND_TRIP_COST），所以比 10% 少一截
  const ret = report.cells[0].ret;
  assert.ok(ret != null);
  assert.ok(
    Math.abs(ret - (1.1 - 1 - ROUND_TRIP_COST)) < 1e-9,
    `期望扣费后 ${(10 - ROUND_TRIP_COST * 100).toFixed(2)}%，实际 ${ret}`,
  );
  assert.ok(ret < 0.1, "必须扣费，不能拿毛收益当样本");
});

test("一套一笔都没卖出：平均收益和胜率都是 null，不能是 0", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [
          // 用一套还在自动建仓的策略。已经下线的策略 needMore 恒为 0，
          // 那条规则由下面单独的测试管，别混在一条里。
          trade({ id: "a", entry: 10, style: "breakout" }),
          trade({ id: "b", entry: 20, style: "breakout" }),
        ],
      }),
    ],
    DEFAULT_RULES,
  );
  const row = report.byStyle.find((item) => item.style === "breakout");
  assert.ok(row);
  assert.equal(row.retired, false);
  assert.equal(row.closed, 0);
  assert.equal(row.open, 2);
  assert.equal(row.avg, null);
  assert.equal(row.win, null);
  assert.equal(row.needMore, PER_STYLE_GOAL);
});

test("已下线的策略标 retired，needMore 是 0——不会再来样本，等一个不会到的数没意义", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [
          trade({ id: "a", entry: 10, style: "value" }),
          trade({ id: "b", entry: 20, style: "relay" }),
          trade({ id: "c", entry: 30, style: "breakout" }),
        ],
      }),
    ],
    DEFAULT_RULES,
  );
  const value = report.byStyle.find((row) => row.style === "value");
  const relay = report.byStyle.find((row) => row.style === "relay");
  const active = report.byStyle.find((row) => row.style === "breakout");
  assert.ok(value && relay && active);
  // 历史样本照常显示——历史要看得见，这是正确行为
  assert.equal(value.total, 1);
  assert.equal(value.retired, true);
  assert.equal(value.needMore, 0);
  assert.equal(relay.retired, true);
  assert.equal(relay.needMore, 0);
  // 「还在跑」的样本用 breakout：2026-10-28 中期反转下线后它是 ACTIVE_STYLES 里唯一一套
  assert.equal(active.retired, false);
  assert.equal(active.needMore, PER_STYLE_GOAL);
});

test("卖出里赚亏都有的那套：胜率和平均照实算，打平的不算赢", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [
          trade({ id: "a", entry: 10, exit: 11, exitDate: "2026-09-30", style: "breakout" }),
          trade({ id: "b", entry: 10, exit: 9, exitDate: "2026-09-30", style: "breakout" }),
          trade({ id: "c", entry: 10, exit: 10, exitDate: "2026-09-30", style: "breakout" }),
        ],
      }),
    ],
    DEFAULT_RULES,
  );
  const row = report.byStyle.find((item) => item.style === "breakout");
  assert.ok(row);
  assert.equal(row.closed, 3);
  // 买 10 卖 10 那笔扣了费是负的，所以不算「盈利」。胜率只数真正赚到手的。
  assert.equal(row.win, 1);
  assert.ok(row.avg != null && row.avg < 0, "一赚一亏加打平，扣费后平均应该略负");
});

test("样本不够时 canSay 是 false，并且要说清还差几笔", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [trade({ id: "a", entry: 10, exit: 11, exitDate: "2026-09-30", style: "early" })],
      }),
    ],
    DEFAULT_RULES,
  );
  assert.equal(report.canSay, false);
  assert.equal(report.closed, 1);
  assert.equal(report.goal, DEFAULT_RULES.minClosed);
  assert.equal(report.needMore, DEFAULT_RULES.minClosed - 1);
  assert.ok(report.reason.includes("还差"), `原因里要有还差几笔：${report.reason}`);
});

test("样本够了但指数对照一条都没有：还是不能说，原因要提指数", () => {
  const closed = Array.from({ length: DEFAULT_RULES.minClosed }, (_, i) =>
    trade({ id: `t${i}`, entry: 10, exit: 10.3, exitDate: "2026-09-30", style: "early" }),
  );
  const report = buildLabReport(
    [day({ date: "2026-09-29", indexEntry: 4300, trades: closed })],
    DEFAULT_RULES,
  );
  assert.equal(report.closed, DEFAULT_RULES.minClosed);
  assert.equal(report.benchmark.available, false);
  assert.equal(report.benchmark.missingDays, 1); // 记了 indexEntry 没 indexExit
  assert.equal(report.canSay, false);
  assert.ok(report.reason.includes("沪深300"), `要提指数：${report.reason}`);
});

test("指数对照齐全、样本够：才给 canSay", () => {
  const closed = Array.from({ length: DEFAULT_RULES.minClosed }, (_, i) =>
    trade({ id: `t${i}`, entry: 10, exit: 10.3, exitDate: "2026-09-30", style: "early" }),
  );
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        indexEntry: 4300,
        indexExit: 4290,
        signalTime: "09:30",
        trades: closed,
      }),
    ],
    DEFAULT_RULES,
  );
  assert.equal(report.benchmark.available, true);
  assert.equal(report.canSay, true);
  assert.equal(report.progress, 100);
});

test("收盘后补记的那天不进样本", () => {
  const withAfterHours = buildLabReport(
    [
      day({ date: "2026-09-29", signalTime: "23:48", trades: [trade({ id: "a", entry: 10, style: "early" })] }),
      day({ date: "2026-09-30", signalTime: "09:31", trades: [trade({ id: "b", entry: 10, style: "early" })] }),
    ],
    DEFAULT_RULES,
  );
  assert.equal(withAfterHours.days, 1);
  assert.equal(withAfterHours.total, 1);
  assert.equal(withAfterHours.cells.length, 1);
});

test("被排掉的天要单独报出来，不能悄悄少掉（包括里面已卖出的）", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        signalTime: "23:48",
        trades: [
          trade({ id: "a", entry: 10, exit: 10.5, exitDate: "2026-09-30", style: "early" }),
          trade({ id: "b", entry: 10, style: "early" }),
        ],
      }),
      day({ date: "2026-09-30", signalTime: "09:31", trades: [trade({ id: "c", entry: 10, style: "early" })] }),
    ],
    DEFAULT_RULES,
  );
  assert.equal(report.skipped.days, 1);
  assert.equal(report.skipped.trades, 2);
  // 那笔已卖出的跟着整天一起被排掉，样本里看不到它
  assert.equal(report.closed, 0);
  assert.equal(report.total, 1);
});

test("样本墙按开仓日期从早到晚铺，日的顺序打乱也要排对", () => {
  const report = buildLabReport(
    [
      day({ date: "2026-09-30", trades: [trade({ id: "b", entry: 10, style: "trend" })] }),
      day({ date: "2026-09-29", trades: [trade({ id: "a", entry: 10, style: "early" })] }),
    ],
    DEFAULT_RULES,
  );
  assert.deepEqual(report.cells.map((cell) => cell.style), ["early", "trend"]);
  assert.equal(report.cells.length, report.total);
});

test("策略卡片按样本量从多到少排，顺序稳定", () => {
  const report = buildLabReport(
    [
      day({
        date: "2026-09-29",
        trades: [
          trade({ id: "a", entry: 10, style: "relay" }),
          trade({ id: "b", entry: 10, style: "relay" }),
          trade({ id: "c", entry: 10, style: "value" }),
        ],
      }),
    ],
    DEFAULT_RULES,
  );
  assert.deepEqual(
    report.byStyle.map((row) => row.style),
    ["relay", "value"],
  );
});

test("账本是空的：全部是 0 而不是崩，结论区照旧说不能下结论", () => {
  const report = buildLabReport([], DEFAULT_RULES);
  assert.equal(report.total, 0);
  assert.equal(report.canSay, false);
  assert.equal(report.reason.includes("还差"), true);
});

test("门槛关掉（minClosed=0）时整块结论交给界面不显示，仍然算得出进度", () => {
  const report = buildLabReport(
    [day({ date: "2026-09-29", trades: [trade({ id: "a", entry: 10, exit: 11, exitDate: "2026-09-30", style: "early" })] })],
    { minClosed: 0 },
  );
  assert.equal(report.goal, 0);
  assert.equal(report.canSay, false);
  assert.ok(report.reason.includes("关掉"));
});

test("认不出来的策略 id 退回 id 本身，不显示空", () => {
  assert.equal(styleName("early"), "启动前期");
  assert.equal(styleName("some-new-style"), "some-new-style");
  assert.equal(styleName(undefined), "未标注策略");
});
