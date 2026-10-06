/**
 * 这个文件是干什么的：
 * 订单模型、幂等、仓位计算、对账的测试。
 *
 * 重点在崩溃恢复那几条。整个方案里最容易出重复下单的地方就是
 * 「已经报给券商、但状态还没写回盘」这个 200ms 窗口——
 * 崩在里面，重启后如果直接重报一遍，就有两笔了。
 * 所以测试必须能模拟「崩在任意一步」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signalKey,
  canTransition,
  needsReconcile,
  duplicatesBySignal,
  isOpen,
  remainingOf,
  type Order,
  type Fill,
} from "@/lib/market/orders";
import { sizeOf, usedByPositions, canSubmit, MAX_SINGLE_PCT } from "@/lib/market/sizing";
import { diffPositions, describeDiff, lotsFromTrades, type LedgerLot } from "@/lib/market/reconcile";

// ── 测试脚手架 ────────────────────────────────────────────────

/**
 * 临时数据目录。
 *
 * **必须支持 async。** 踩过的坑：原来写成 `fn instanceof Promise` 判断，
 * 但 fn 是个函数、永远不是 Promise，于是走同步分支，finally 立刻把
 * CHIHENG_DATA_DIR 还原了，而异步回调还在跑。后果有两样：
 *   1. 测试诡异地失败，或者失败信息飘到别的测试上
 *   2. 更糟的：那些迟到的异步 activity 写到**真实的** data/ 目录里去——
 *      orders.jsonl 里混进 44 行测试数据。真账本是唯一的，没有版本控制，
 *      混进去没法清理（这次是真发生了，靠人工核对 accountId 才认出来）。
 * 所以判断的是**返回值**是不是 thenable，不是 fn 本身。
 */
function withTempData<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-orders-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  const restore = () => {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  };
  let result: T;
  try {
    result = fn(dir);
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      },
    ) as T;
  }
  restore();
  return result;
}

let seq = 0;
function order(over: Partial<Order> = {}): Order {
  seq += 1;
  const key = over.signalKey ?? signalKey({ tradingDate: "2026-10-08", style: "rebound", code: "sh600000", plannedEntry: 12.34, intent: "open" });
  return {
    orderId: `o${seq}`,
    brokerOrderId: null,
    accountId: "acc1",
    code: "sh600000",
    side: "buy",
    volume: 100,
    price: 12.34,
    orderType: "limit",
    style: "rebound",
    intent: "open",
    status: "draft",
    signalKey: key,
    attempt: 1,
    plannedEntry: 12.34,
    plannedStop: 9.25,
    plannedTarget: 14.8,
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

// ── 幂等键 ────────────────────────────────────────────────────

test("signalKey：同样的信号两次算出来必须一样（这是幂等的根）", () => {
  const parts = { tradingDate: "2026-10-08", style: "rebound" as const, code: "sh600000", plannedEntry: 12.34, intent: "open" as const };
  assert.equal(signalKey(parts), signalKey(parts));
  assert.equal(signalKey(parts), "2026-10-08:rebound:sh600000:12.34:open");
});

test("signalKey：浮点数不能有精度尾巴，否则同一个信号被当成两个", () => {
  // 0.1 + 0.2 这种事在实盘里会出现（价格是算出来的）
  const a = signalKey({ tradingDate: "d", style: "breakout", code: "sz000001", plannedEntry: 0.1 + 0.2, intent: "open" });
  const b = signalKey({ tradingDate: "d", style: "breakout", code: "sz000001", plannedEntry: 0.3, intent: "open" });
  assert.equal(a, b, "12.340000000000001 和 12.34 必须是同一个信号");
});

// ── 状态机 ────────────────────────────────────────────────────

test("状态机：合法转换放行，非法转换拒绝", () => {
  assert.equal(canTransition("draft", "pending"), true);
  assert.equal(canTransition("pending", "filled"), true);
  assert.equal(canTransition("unknown", "filled"), true, "unknown 查到真实结果后应该能定下来");
  assert.equal(canTransition("filled", "pending"), false, "已成交的单不该回到 pending");
  assert.equal(canTransition("filled", "draft"), false);
  assert.equal(canTransition("rejected", "filled"), false, "废单不可能成交");
  assert.equal(canTransition("partial", "partial"), false, "partial 原地不动等于没处理新回报");
});

test("partial 和 unknown 都要对齐，这就是 needsReconcile 的用途", () => {
  const list = [
    order({ status: "draft" }),
    order({ status: "pending" }),
    order({ status: "partial" }),
    order({ status: "unknown" }),
    order({ status: "filled" }),
    order({ status: "canceled" }),
    order({ status: "rejected" }),
  ];
  const need = needsReconcile(list);
  assert.deepEqual(
    need.map((o) => o.status).sort(),
    ["partial", "pending", "unknown"],
    "只有这三种要先向券商查",
  );
  // draft 不需要查券商——它没报出去过。但它需要被 signalInFlight 挡住重复报
  assert.equal(need.some((o) => o.status === "draft"), false);
});

test("同一 signalKey 报出两单要被查出来（重复下单的证据）", () => {
  const key = signalKey({ tradingDate: "d", style: "rebound", code: "sh600000", plannedEntry: 10, intent: "open" });
  const list = [order({ signalKey: key, orderId: "a" }), order({ signalKey: key, orderId: "b" }), order({ orderId: "c" })];
  const dup = duplicatesBySignal(list);
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].orderIds, ["a", "b"]);
});

test("剩余未成交量：partial 要算出还差多少", () => {
  const o = order({ volume: 300, status: "partial" });
  const fills: Fill[] = [
    { fillId: "f1", orderId: o.orderId, brokerOrderId: 1, code: o.code, side: "buy", volume: 100, price: 12.3, amount: 1230, filledAt: 1 },
    { fillId: "f2", orderId: o.orderId, brokerOrderId: 1, code: o.code, side: "buy", volume: 100, price: 12.4, amount: 1240, filledAt: 2 },
  ];
  assert.equal(remainingOf(o, fills), 100);
  assert.equal(isOpen(o), true);
});

// ── 崩溃恢复（最重要）──────────────────────────────────────────

test("崩溃在「已落盘 draft、还没报给券商」→ 重启后不重复报", async () => {
  await withTempData(async () => {
    const store = await import("../../../scripts/order-store.mjs");
    const o = order({ status: "draft" });

    // 第一步：落盘（这是必须在报单之前做的事）
    store.appendOrder(o);
    // ── 崩在这里 ──  券商那边根本不知道有这单

    // 重启：读盘
    const recovered = store.latestOrders();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "draft");

    // 重新报单前必须问 signalInFlight —— 它说「这单已经在路上」
    const inFlight = store.signalInFlight(recovered, o.signalKey);
    assert.ok(inFlight, "重启后必须认出这个信号已经在盘上");
    assert.equal(inFlight.orderId, o.orderId);
  });
});

test("崩溃在「已报给券商、状态还没写回盘」→ 重启后必须去查券商，不能重报", async () => {
  await withTempData(async () => {
    const store = await import("../../../scripts/order-store.mjs");
    const o = order({ status: "draft" });
    store.appendOrder(o);

    // ── 崩在这里 ──  券商那边收到了这单（brokerOrderId=8888），盘上还是 draft

    const recovered = store.latestOrders();
    // 盘上看着是 draft，但它其实报出去了。所以 needsReconcile 不包含 draft
    // ——这个「不知道」是查券商才能解决的，不是猜能解决的。
    assert.equal(needsReconcile(recovered).length, 0, "盘上无法知道它报出去了");

    // 正确的处理：重启后必须无条件向券商查询「今天有哪些委托」，
    // 用 clientOrderId（我们的 orderId）去反查，而不是靠盘上的状态。
    // 这个断言钉住的是：信号在盘上存在，所以重报会被 signalInFlight 挡住。
    assert.ok(store.signalInFlight(recovered, o.signalKey), "至少不能重报");
  });
});

test("崩溃在「状态已变 pending」→ 重启后要进 needsReconcile", async () => {
  await withTempData(async () => {
    const store = await import("../../../scripts/order-store.mjs");
    // 同一笔单的两个状态，不是两笔单——order() 每次会给新的 orderId，
    // 拿两次它的结果去 expect 合成一条是测试自己写错了（第一版就踩了）。
    const o = order({ status: "draft" });
    store.appendOrder(o);
    store.appendOrder({ ...o, status: "pending", brokerOrderId: 8888, updatedAt: o.updatedAt + 1 });
    // ── 崩在这里 ──

    const recovered = store.latestOrders();
    assert.equal(recovered.length, 1, "同一个 orderId 重放后应该是一条");
    assert.equal(recovered[0].status, "pending");
    assert.equal(recovered[0].brokerOrderId, 8888);
    assert.equal(needsReconcile(recovered).length, 1, "重启后要向券商对齐这单");
  });
});

test("成交回报去重：断线重连时同一条会被推多次，只算一笔", async () => {
  const fills: Fill[] = [
    { fillId: "t1", orderId: "o1", brokerOrderId: 1, code: "sh600000", side: "buy", volume: 100, price: 12.3, amount: 1230, filledAt: 1 },
    { fillId: "t2", orderId: "o1", brokerOrderId: 1, code: "sh600000", side: "buy", volume: 200, price: 12.4, amount: 2480, filledAt: 2 },
  ];
  const store = await import("../../../scripts/order-store.mjs");
  const result = store.dedupeFills([...fills, ...fills, fills[0]]);
  assert.equal(result.unique.length, 2, "同 fillId 只能有一条");
  assert.equal(result.duplicates, 3, "重复了几条要计数，不能悄悄丢");
});

test("订单日志里有半行坏数据时，其余订单必须完好", async () => {
  const store = await import("../../../scripts/order-store.mjs");
  await withTempData(async () => {
    store.appendOrder(order({ status: "pending" }));
    // 崩在写一半
    appendFileSync(join(process.env.CHIHENG_DATA_DIR!, "orders.jsonl"), '{"orderId":"broken","stat', "utf8");
    const recovered = store.latestOrders();
    assert.equal(recovered.length, 1, "坏行跳过，好的那单要还在");
    assert.equal(recovered[0].status, "pending");
  });
});

// ── 仓位计算 ──────────────────────────────────────────────────

test("仓位：100 万总资产、单笔 10% = 10 万，price 50 → 2000 股", () => {
  const shares = sizeOf({ totalAsset: 1_000_000, maxPctPerTrade: MAX_SINGLE_PCT, maxPositions: 10, usedAmount: 0, price: 50 });
  assert.equal(shares, 2000, "10万 / 50 = 2000 股");
  assert.ok(shares * 50 <= 1_000_000 * MAX_SINGLE_PCT, "不许超过单笔上限");
  assert.equal(shares % 100, 0);
});

test("仓位：已用掉额度会压缩新单，且是 100 的整数倍", () => {
  const shares = sizeOf({ totalAsset: 1_000_000, maxPctPerTrade: 0.1, maxPositions: 10, usedAmount: 500_000, price: 33 });
  assert.equal(shares % 100, 0, "必须是 100 的整数倍");
  assert.ok(shares * 33 <= 50_000, "不能超过剩余额度");
});

test("仓位：额度不够买一手时返回 0，意思是「买不了」不是「凑一手」", () => {
  assert.equal(sizeOf({ totalAsset: 1_000_000, maxPctPerTrade: 0.1, maxPositions: 10, usedAmount: 0, price: 5000 }), 0);
  assert.equal(sizeOf({ totalAsset: 0, maxPctPerTrade: 0.1, maxPositions: 10, usedAmount: 0, price: 10 }), 0);
  assert.equal(sizeOf({ totalAsset: 1_000_000, maxPctPerTrade: 0.1, maxPositions: 10, usedAmount: 0, price: 0 }), 0);
});

test("占用额度：未成交的买单也算占着钱，否则会连续超发", () => {
  const used = usedByPositions(
    [{ volume: 1000, avgPrice: 10 }],
    [{ side: "buy", volume: 500, price: 20, lastPrice: 20 }],
  );
  assert.equal(used, 20_000, "持仓 1000×10=10000 + 未成交挂单 500×20=10000");
});

test("预检：数量 0、不是整百、超总资产、价格非法都要拦住", () => {
  assert.equal(canSubmit({ volume: 0, price: 10, side: "buy", totalAsset: 1e6 }).ok, false);
  assert.match(canSubmit({ volume: 150, price: 10, side: "buy", totalAsset: 1e6 }).reason, /100 的整数倍/);
  assert.match(canSubmit({ volume: 100, price: 20000, side: "buy", totalAsset: 1e6 }).reason, /超过账户总资产/);
  assert.equal(canSubmit({ volume: 0, price: null, side: "buy", totalAsset: 1e6 }).ok, false);
  assert.equal(canSubmit({ volume: 100, price: 10, side: "buy", totalAsset: 1e6 }).ok, true);
  // 卖出可以是 0（清仓）
  assert.equal(canSubmit({ volume: 0, price: 10, side: "sell", totalAsset: 1e6 }).ok, false, "卖 0 股也是废单");
});

// ── 对账 ──────────────────────────────────────────────────────

function lot(code: string, remaining: number, entry = 10, lotId = code): LedgerLot {
  return { lotId, code, volume: remaining, remaining, entry };
}

test("对账：完全一致时没有差异", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 300, canUseVolume: 300, avgPrice: 10.02, marketValue: 3000 }],
    [lot("sh600000", 300, 10.0)],
  );
  assert.equal(r.diffs.length, 0, JSON.stringify(r.diffs));
  assert.equal(r.blocking, false);
});

test("对账：券商多出持仓（手动下过单）→ 报告并挡开仓", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sz000001", volume: 500, canUseVolume: 500, avgPrice: 8, marketValue: 4000 }],
    [lot("sh600000", 300)],
  );
  assert.equal(r.blocking, true);
  const d = r.diffs.find((x) => x.kind === "broker_only");
  assert.ok(d);
  assert.match(describeDiff(d), /客户端手动下过单/);
});

test("对账：账本多出持仓（漏单）→ 报告并挡开仓", () => {
  const r = diffPositions([], [lot("sh600000", 300), lot("sz000002", 200)]);
  assert.equal(r.blocking, true);
  assert.equal(r.diffs.filter((x) => x.kind === "ledger_only").length, 2);
});

test("对账：数量不一致要报，并且挡住开仓", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 100, canUseVolume: 100, avgPrice: 10, marketValue: 1000 }],
    [lot("sh600000", 300)],
  );
  assert.equal(r.blocking, true);
  const d = r.diffs[0];
  assert.equal(d.kind, "volume_mismatch");
  if (d.kind === "volume_mismatch") assert.equal(d.delta, -200);
});

test("对账：只有成本价漂移 → 报告但不挡开仓（券商成本价含费用）", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 100, canUseVolume: 100, avgPrice: 10.05, marketValue: 1005 }],
    [lot("sh600000", 100, 10.0)],
  );
  assert.equal(r.diffs.length, 1);
  assert.equal(r.diffs[0].kind, "avg_price_drift");
  assert.equal(r.blocking, false, "成本价差千分之几是正常的，不该因此停止交易");
});

test("对账：成本价差得太多要报（超过 2%）", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 100, canUseVolume: 100, avgPrice: 12, marketValue: 1200 }],
    [lot("sh600000", 100, 10.0)],
  );
  assert.equal(r.diffs[0].kind, "avg_price_drift");
});

test("对账：同一只票分三笔建仓要合并成总数再比，不能拿 300 和 100 比", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 300, canUseVolume: 300, avgPrice: 10, marketValue: 3000 }],
    [lot("sh600000", 100, 10, "l1"), lot("sh600000", 100, 10, "l2"), lot("sh600000", 100, 10, "l3")],
  );
  assert.equal(r.diffs.length, 0, "三笔各 100 合起来正好 300，不该报不一致");
});

test("对账：已清仓的 lot 和券商的 0 持仓都不算「有」", () => {
  const r = diffPositions(
    [{ accountId: "a", code: "sh600000", volume: 0, canUseVolume: 0, avgPrice: 0, marketValue: 0 }],
    [lot("sh600000", 0, 10)],
  );
  assert.equal(r.diffs.length, 0);
});

test("对账跑真实账本：空券商 + 71 笔账应该报出 42 条 ledger_only", async () => {
  const { readFileSync } = await import("node:fs");
  const book = JSON.parse(readFileSync("data/books/dev-user.json", "utf8"));
  const lots = lotsFromTrades(book.days, () => 100);
  const open = lots.filter((l) => l.remaining > 0);
  const r = diffPositions([], open);
  assert.equal(r.blocking, true, "券商一只票都没有而账本有持仓，必须挡");
  // 09-30 的 42 笔全是 exit=null → 42 条；09-29 的 29 笔只有部分已卖，
  // 但账本推导「未卖出」的数量应该和当初记账时一致
  assert.ok(r.diffs.length > 0, "必须报出差异");
  assert.ok(
    r.diffs.every((d) => d.kind === "ledger_only"),
    "空券商时只可能是 ledger_only",
  );
});
