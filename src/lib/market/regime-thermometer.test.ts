import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRegime, todayRegime } from "./regime-thermometer.ts";

/** 造一段数据：前 30 天在 MA20 上方缓慢上行（进攻），后 30 天跌破下行（空仓）。 */
function makeSeries(): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  let price = 100;
  for (let i = 0; i < 30; i++) {
    price *= 1.005;
    out.push({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, close: price });
  }
  for (let i = 30; i < 60; i++) {
    price *= 0.995;
    out.push({ date: `2026-02-${String(i - 29).padStart(2, "0")}`, close: price });
  }
  return out;
}

test("computeRegime：上行段给进攻/观察，下行段给空仓", () => {
  const days = computeRegime(makeSeries());
  assert.ok(days.length > 0);
  // 上行段趋势确立后应是进攻（days 从原序列 index 20 开始，
  // 上行段 30 天里前 20 天被跳过，days[0..9] 是上行段尾部，全部应进攻）
  const lateUptrend = days.slice(0, 10);
  assert.ok(lateUptrend.every((d) => d.regime === "进攻"), "上行趋势确立后应是进攻");
  // 下行段的后半应是空仓
  const lastHalf = days.slice(-10);
  assert.ok(lastHalf.every((d) => d.regime === "空仓"), "持续下跌段应是空仓");
});

test("todayRegime：返回最后一天", () => {
  const series = makeSeries();
  const t = todayRegime(series);
  assert.ok(t);
  assert.equal(t!.date, series[series.length - 1].date);
});

test("数据不足时不算（MA20 需要 20 天）", () => {
  const short = [{ date: "2026-01-01", close: 100 }];
  assert.equal(computeRegime(short).length, 0);
});
