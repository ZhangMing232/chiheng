/**
 * 这个文件是干什么的：
 * 守住「每天每套最多 10 只」和「重复选中以最先的为主」这两条规矩。
 *
 * 你需要知道的：
 * 名额是按天算的：昨天进的那批就算还没卖出，也不占今天的名额。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { daySlotsLeft, takeBuys, watchList, MAX_POSITIONS, type Listed } from "@/lib/market/strategies";
import { DEFAULT_RULES } from "@/lib/market/rules";

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

test("另一套策略还在持有的票，这套不再买第二遍", () => {
  // 钱是同一个账户出的。一只票手上已经有了，换套策略再买一遍等于双倍下注，
  // 而且两笔的止损和目标各不相同，事后算不清是哪套挣的。
  const heldBreakout = [trade("sz0001", "breakout")];
  assert.deepEqual(ids(takeBuys([row("sz0001"), row("sz0002")], heldBreakout, "value", [])), ["sz0002"]);
});

test("那笔卖出之后，别的策略可以重新买它", () => {
  const soldByBreakout = [trade("sz0001", "breakout", 11)];
  assert.deepEqual(ids(takeBuys([row("sz0001")], soldByBreakout, "value", [])), ["sz0001"]);
});

test("同套内部仍然排重，这条不能因为上面的改动丢了", () => {
  const sameStyle = [trade("sz0001", "value")];
  assert.deepEqual(ids(takeBuys([row("sz0001"), row("sz0002")], sameStyle, "value", [])), ["sz0002"]);
});

const picks = (quotes: ReturnType<typeof quote>[]) => watchList(quotes, "rebound", DEFAULT_RULES, () => true);

test("中期反转：60 日跌得多的排在前面", () => {
  const deep = { ...quote("sz0001"), d60: -45 };
  const shallow = { ...quote("sz0002"), d60: -12 };
  assert.deepEqual(
    picks([shallow, deep]).map((row) => row.quote.id),
    ["sz0001", "sz0002"],
  );
});

test("中期反转：按现价买，止损 -25%，目标 +20%", () => {
  const list = picks([{ ...quote("sz0001"), d60: -30, price: 10 }]);
  assert.equal(list.length, 1);
  // 按现价买，不是挂一个更高的价等它回落——这套买的本来就是正在跌的票
  assert.equal(list[0].buy, 10);
  assert.equal(list[0].stop, 7.5);
  assert.equal(list[0].sell, 12);
});

test("中期反转：ST、四元以下、四十亿以下都不进", () => {
  assert.equal(picks([{ ...quote("sz0001"), d60: -30, st: true }]).length, 0);
  assert.equal(picks([{ ...quote("sz0001"), d60: -30, price: 3.5 }]).length, 0);
  assert.equal(picks([{ ...quote("sz0001"), d60: -30, cap: 20 }]).length, 0);
});

test("中期反转：涨过的票不进", () => {
  assert.equal(picks([{ ...quote("sz0001"), d60: 8 }]).length, 1);
  // 排名靠后而已，不是不能进；真正挡住它的是分数排序和每天十个名额
  assert.ok(picks([{ ...quote("sz0001"), d60: 8 }])[0].score < picks([{ ...quote("sz0002"), d60: -20 }])[0].score);
});

test("takeChallengerBuy：冠军名额买满后挑战者仍能拿 1 只，但已持仓的双押不拿", async () => {
  const { takeChallengerBuy } = await import("@/lib/market/strategies");
  // 冠军今天已买满 10 只（takeBuys 在这种情况下返回 0）——挑战者照拿自己的 1 只
  const today = Array.from({ length: MAX_POSITIONS }, (_, i) => trade(`sz1111${i}`, "breakout"));
  assert.equal(takeBuys(series("sz2222", 5), [], "breakout", today).length, 0);
  const got = takeChallengerBuy(series("sz2222", 5), today, 0);
  assert.ok(got);
  assert.equal(got.quote.id, "sz22220");
  // 预登记「每天限 1 只」：今天已落账 1 只就不再拿——不查这个的话，
  // 每分钟 run 会各买一只新票（10-21 实测 32 分钟买 3 只）
  assert.equal(takeChallengerBuy(series("sz2222", 5), today, 1), null);
  // 已持仓的票不双押：sz22220 持仓中就跳过它，拿下一个候选 sz22221
  const skip = takeChallengerBuy(series("sz2222", 5), [...today, trade("sz22220", "breakout")], 0);
  assert.ok(skip);
  assert.equal(skip.quote.id, "sz22221");
  // 全部候选都已持仓 → 无票可拿
  assert.equal(
    takeChallengerBuy(series("sz2222", 5), [...today, ...Array.from({ length: 5 }, (_, i) => trade(`sz2222${i}`, "breakout"))], 0),
    null,
  );
});

// ── deepScanChallengerBuy（DECISIONS #4 方案 D：名单饱和深扫）──────────

test("深扫：主名单前 10 全被持仓挡死，从原名单第 11 名拿", async () => {
  const { deepScanChallengerBuy } = await import("@/lib/market/strategies");
  const held = Array.from({ length: 10 }, (_, i) => trade(`sz330${i}`, "breakout"));
  const got = deepScanChallengerBuy(series("sz33", 20), held);
  // 回归点：曾写成「先过滤再 slice(10)」——被持仓挡掉的前 10 名在过滤时从数组里
  // 消失，第 11 名顶到下标 0，slice(10) 把它跳过去，饱和场景反而一个都选不出来
  assert.ok(got, "饱和场景必须能拿到第 11 名");
  assert.equal(got.quote.id, "sz3310");
});

test("深扫永远不碰原名单前 10 名：即使前 10 全可买，也只看第 11~20 名", async () => {
  const { deepScanChallengerBuy } = await import("@/lib/market/strategies");
  const got = deepScanChallengerBuy(series("sz44", 20), []);
  assert.ok(got);
  assert.equal(got.quote.id, "sz4410");
});

test("深扫：第 11~20 名也全被持仓挡死时返回 null", async () => {
  const { deepScanChallengerBuy } = await import("@/lib/market/strategies");
  const list = series("sz55", 20).map((r, i) => ({ ...r, quote: { ...r.quote, id: `sz55${String(i).padStart(2, "0")}` } }));
  const held = list.map((r) => trade(r.quote.id, "breakout"));
  assert.equal(deepScanChallengerBuy(list, held), null);
});
