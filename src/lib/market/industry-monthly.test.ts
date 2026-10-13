/**
 * 这个文件是干什么的：
 * 钉住 D5 月度聚合的口径——这几条都是从坑里来的，谁改谁先看这里。
 *
 * 重点：
 * 1. 月涨跌幅以上月月末收盘为基准（不是月内首日开盘）
 * 2. 资金流缺失是 null 不是 0
 * 3. 交易日太少的月标 partial，不参与下结论
 * 4. 当月没走完也标 partial
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeMonths,
  monthlyFromBars,
  parseBoardDaily,
  parseBoardFlow,
  recentMonths,
  thermometer,
  type BoardDaily,
} from "@/lib/market/industry-monthly";

const day = (date: string, close: number, extra: Partial<BoardDaily> = {}): BoardDaily => ({
  date,
  open: close,
  close,
  high: close,
  low: close,
  amount: 1e8,
  turnover: 2,
  ...extra,
});

/** 2026-08 全月平盘 100，2026-09 从 100 涨到 110。 */
function twoMonths(): BoardDaily[] {
  const bars: BoardDaily[] = [];
  for (let d = 1; d <= 31; d += 1) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    bars.push(day(date, 100));
  }
  for (let d = 1; d <= 30; d += 1) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    bars.push(day(date, 100 + d / 3));
  }
  return bars;
}

test("月涨跌幅以上月月末收盘为基准，不用月内首日开盘", () => {
  const { months } = monthlyFromBars(twoMonths());
  const sep = months.find((m) => m.month === "2026-09")!;
  // 8 月月末 100，9 月月末 110 → +10%
  assert.ok(Math.abs((sep.chgPct ?? 0) - 10) < 0.01, `实际 ${sep.chgPct}`);
  // 第一个月没有上月基准 → null，不是 0（0 会被读成「没涨没跌」）
  const aug = months.find((m) => m.month === "2026-08")!;
  assert.equal(aug.chgPct, null);
});

test("资金流缺失的月份是 null 不是 0", () => {
  const { months } = monthlyFromBars(twoMonths(), []);
  assert.equal(months.find((m) => m.month === "2026-09")!.mainNet, null);
  // 给了资金流就算合计
  const flow = [{ date: "2026-09-01", mainNet: -1e8 }, { date: "2026-09-02", mainNet: 3e8 }];
  const withFlow = monthlyFromBars(twoMonths(), flow);
  assert.equal(withFlow.months.find((m) => m.month === "2026-09")!.mainNet, 2e8);
});

test("交易日太少的月标 partial，且不参与下结论", () => {
  const bars = [day("2026-09-01", 100), day("2026-09-02", 110)];
  const { months, gaps } = monthlyFromBars(bars);
  assert.equal(months[0]!.partial, true);
  assert.equal(completeMonths(months).length, 0);
  assert.match(gaps[0]!, /只有 2 个交易日/);
});

test("当月还没走完也标 partial", () => {
  const { months } = monthlyFromBars(twoMonths(), [], "2026-09-15");
  assert.equal(months.find((m) => m.month === "2026-09")!.partial, true);
  assert.equal(months.find((m) => m.month === "2026-08")!.partial, false);
});

test("温度计：价格与主力资金同向才算升温，反向是背离", () => {
  const bars: BoardDaily[] = [];
  // 多造一个月在前面：最近三个月的 chgPct 都要有上月基准（第一个月恒 null）
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  let price = 100;
  months.forEach((month, mi) => {
    for (let d = 1; d <= 20; d += 1) {
      price += mi === 2 ? -0.1 : 0.5;
      bars.push(day(`${month}-${String(d).padStart(2, "0")}`, price));
    }
  });
  const flow = months.map((month) => ({ date: `${month}-05`, mainNet: 1e8 }));
  const { months: agg } = monthlyFromBars(bars, flow, "2026-09-15");
  const t = thermometer(agg, 3);
  assert.equal(t.direction, "升温");
  assert.match(t.basis, /月涨 2 \/ 月跌 1/);

  // 资金全流出，价格还在涨 → 背离，不能说升温
  const bearFlow = months.map((month) => ({ date: `${month}-05`, mainNet: -1e8 }));
  const t2 = thermometer(monthlyFromBars(bars, bearFlow, "2026-09-15").months, 3);
  assert.equal(t2.direction, "背离");
});

test("没有完整月份时温度计说不明，不说中性", () => {
  const t = thermometer([], 3);
  assert.equal(t.direction, "不明");
  assert.match(t.basis, /没有完整月份/);
});

test("recentMonths 不足就少给，不补齐", () => {
  const { months } = monthlyFromBars(twoMonths(), [], "2026-09-15");
  assert.equal(recentMonths(months, 6).length, 1, "9 月是 partial，只剩 8 月");
});

test("解析东财板块日线：坏行跳过，按日期升序", () => {
  const payload = {
    data: {
      klines: [
        "2026-09-30,14515.96,13790.10,14515.96,13781.19,12351983,62665726925.00,5.09,-4.56,-659.63,4.39",
        "2026-10-08,13840.35,13426.07,14270.25,13295.57,12607770,78440772239.00,7.07,-2.64,-364.03,4.48",
        "坏行",
      ],
    },
  };
  const rows = parseBoardDaily(payload);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.date, "2026-09-30");
  assert.equal(rows[0]!.close, 13790.1);
  assert.equal(rows[0]!.turnover, 4.39);
});

test("解析东财板块资金流", () => {
  const rows = parseBoardFlow({ data: { klines: ["2026-09-30,-3161845248.0,3200847616.0,-5.05"] } });
  assert.deepEqual(rows, [{ date: "2026-09-30", mainNet: -3161845248 }]);
  assert.deepEqual(parseBoardFlow({}), []);
});
