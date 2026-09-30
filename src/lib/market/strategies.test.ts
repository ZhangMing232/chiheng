/**
 * 这个文件是干什么的：
 * 守住「每天每套最多 10 只」和「重复选中以最先的为主」这两条规矩。
 *
 * 你需要知道的：
 * 名额是按天算的：昨天进的那批就算还没卖出，也不占今天的名额。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { daySlotsLeft, takeBuys, MAX_POSITIONS, type Listed } from "@/lib/market/strategies";

function quote(id: string, chg = 0) {
  return {
    id,
    code: id.slice(2),
    name: id,
    board: "sz" as const,
    price: 10,
    chg,
    pe: 10,
    pb: 1,
    cap: 100,
    floatCap: 80,
    turnover: 3,
    volRatio: 1.5,
    amp: 2,
    d5: 1,
    d10: 1,
    d20: 1,
    d60: 1,
    ytd: 1,
    inflow: 0,
    amount: 10000,
    st: false,
  };
}

function row(id: string, hit = true, chg = 0): Listed {
  return { quote: quote(id, chg), score: 1, reasons: [], buy: 10, sell: 12, stop: 9, hit };
}

function trade(id: string, style: string, exit: number | null = null) {
  return { id, style, exit };
}

function series(prefix: string, n: number): Listed[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
}

const ids = (rows: Listed[]) => rows.map((item) => item.quote.id);

test("前几天还没卖出的不占今天的名额", () => {
  const heldYesterday = Array.from({ length: MAX_POSITIONS }, (_, i) => trade(`sh60000${i}`, "value"));
  assert.equal(daySlotsLeft([], "value"), MAX_POSITIONS);
  assert.equal(takeBuys(series("sz0000", 12), heldYesterday, "value", []).length, MAX_POSITIONS);
});

test("当天建满之后不再进新的", () => {
  const today = Array.from({ length: MAX_POSITIONS }, (_, i) => trade(`sz1111${i}`, "value"));
  assert.equal(daySlotsLeft(today, "value"), 0);
  assert.equal(takeBuys(series("sz2222", 5), [], "value", today).length, 0);
});

test("只剩几个名额就只进几只", () => {
  const today = Array.from({ length: MAX_POSITIONS - 3 }, (_, i) => trade(`sz3333${i}`, "value"));
  assert.equal(takeBuys(series("sz4444", 8), [], "value", today).length, 3);
});

test("当天卖出的也算占过名额，不退回", () => {
  const today = [trade("sz0001", "value", 11), trade("sz0002", "value", 12)];
  assert.equal(daySlotsLeft(today, "value"), MAX_POSITIONS - 2);
});

test("重复选中时以最先那笔为主，不再开第二笔", () => {
  const held = [trade("sz0001", "value")];
  assert.deepEqual(ids(takeBuys([row("sz0001"), row("sz0002")], held, "value", [])), ["sz0002"]);
});

test("名单内部重复提名只进一次，以最先出现的为准", () => {
  const first = row("sz0001");
  const duplicate = { ...row("sz0001"), sell: 15 };
  const result = takeBuys([first, duplicate, row("sz0002")], [], "relay", []);
  assert.deepEqual(ids(result), ["sz0001", "sz0002"]);
  assert.equal(result[0].sell, 12);
});

test("之前那笔已经卖出，可以重新进", () => {
  const held = [trade("sz0001", "value", 11)];
  assert.deepEqual(ids(takeBuys([row("sz0001")], held, "value", [])), ["sz0001"]);
});

test("涨停买不进、没到价的不进", () => {
  assert.deepEqual(ids(takeBuys([row("sz0001", true, 9.99), row("sz0002")], [], "value", [])), ["sz0002"]);
  assert.deepEqual(ids(takeBuys([row("sz0001", false), row("sz0002", true)], [], "value", [])), ["sz0002"]);
});

test("只认自己这一套，别的套不影响名额", () => {
  const today = Array.from({ length: MAX_POSITIONS }, (_, i) => trade(`sz5555${i}`, "trend"));
  assert.equal(daySlotsLeft(today, "value"), MAX_POSITIONS);
  assert.equal(daySlotsLeft(today, "trend"), 0);
});
