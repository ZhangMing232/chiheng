/**
 * 这个文件是干什么的：
 * QMT 桥接的契约测试。**不碰真 QMT、不需要 Windows**——用 fake-bridge.py
 * 起一个真子进程、走真管道，把各种故障场景演一遍。
 *
 * 为什么值得单独写一套：
 * 订单模型测试（orders.test.ts）验的是「算得对不对」，而这里验的是
 * **「出故障的时候会不会伤害我的钱」**。后者才是自动化交易里真正要命的部分。
 *
 * 跑法：node scripts/test-bridge-contract.mjs
 * 挂到 CI：npm test 之外单独跑，因为要起子进程，慢一点。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createBridge, BridgeError } from "./qmt-bridge.mjs";
import { signalKey, needsReconcile } from "../src/lib/market/orders.ts";

const FAKE = "scripts/fake-bridge.py";
const PYTHON = process.env.PYTHON ?? "python3";

/** 起一个假桥。mode 走环境变量控制故障场景。 */
function withBridge(env, fn, { timeoutMs = 1500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-bridge-"));
  const logPath = join(dir, "protocol.log");
  const bridge = createBridge({
    pythonPath: PYTHON,
    scriptPath: FAKE,
    timeoutMs,
    // **必须传 env**：假桥靠 FAKE_MODE 控制故障场景，不传就全是 normal 模式，
    // 契约测试会「全都跑过了但一个故障都没演到」——比没有测试更糟。
    env,
    init: { sessionId: "test-1", userdataPath: "D:\\fake", accountId: "TEST001", expectedTotalAsset: 1000000 },
  });
  bridge.start();
  return fn(bridge, dir, logPath).finally(() => {
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });
}

function envOf(extra = {}) {
  return { FAKE_MODE: "normal", FAKE_LOG: undefined, ...extra };
}

function waitFor(bridge, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等了 ${ms}ms 没等到 ${event}`)), ms);
    bridge.on(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function readsLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── 1. 桥死了 ────────────────────────────────────────────────

test("桥进程立刻死 → stdin EOF → 请求全部作废，且不许再下单", async () => {
  await withBridge(envOf({ FAKE_MODE: "die_on_start" }), async (bridge) => {
    const fatal = await waitFor(bridge, "fatal");
    assert.match(fatal.message, /EOF|退出/, "必须通过 EOF 或 exit 察觉到，不是靠超时");

    assert.equal(bridge.isAlive(), false);
    assert.equal(bridge.canTrade(), false, "死了就绝不能下单");

    // 在等的请求要作废，不能永远挂着
    await assert.rejects(() => bridge.request("asset", {}, 3000), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, "BRIDGE_DIED");
      return true;
    });
  });
});

test("桥发 fatal 然后退出 → 立刻停手，不等超时", async () => {
  await withBridge(envOf({ FAKE_MODE: "fatal" }), async (bridge) => {
    const fatal = await waitFor(bridge, "fatal");
    assert.match(fatal.message, /xtquant/);
    assert.equal(bridge.canTrade(), false);
  });
});

test("桥活着但没握手完 → isAlive 为真但 canTrade 为假（不能只判断进程在不在）", async () => {
  await withBridge(envOf({ FAKE_MODE: "no_ready" }), async (bridge) => {
    // 等它连上了
    await waitFor(bridge, "on_connected");
    assert.equal(bridge.isAlive(), true, "进程确实活着");
    assert.equal(bridge.canTrade(), false, "但没发 ready，不许下单 —— 这是最容易漏的一档");
  });
});

// ── 2. 桥卡住（不死也不说话）──────────────────────────────────

test("桥卡住不回话 → 请求超时，而且错误码要说清「状态不明」而不是「失败」", async () => {
  await withBridge(envOf({ FAKE_MODE: "hang_queries" }), async (bridge) => {
    await waitFor(bridge, "ready");
    await assert.rejects(() => bridge.request("orders", {}, 400), (err) => {
      assert.equal(err.code, "TIMEOUT");
      // 这条措辞很重要：超时的单状态不明，上层必须当 unknown 去券商查，
      // 不能当成失败就重报——那正是重复下单的来源。
      assert.match(err.message, /状态不明/);
      return true;
    });
  });
});

// ── 3. 协议容错 ───────────────────────────────────────────────

test("桥喷了非 JSON 的行 → 后面正常的消息照样收到（不能一行坏就丢掉全部）", async () => {
  await withBridge(envOf({ FAKE_MODE: "noisy" }), async (bridge) => {
    await waitFor(bridge, "ready");
    const data = await bridge.request("asset", {}, 2000);
    assert.equal(typeof data.totalAsset, "number", "噪声之后请求还是要能通");
  });
});

// ── 4. 成交回报去重（断线重连会重推）──────────────────────────

test("同一 tradedId 推两次 → 只记一笔成交", async () => {
  await withBridge(envOf({ FAKE_DUP_FILL: "1" }), async (bridge) => {
    await waitFor(bridge, "ready");
    const first = waitFor(bridge, "on_stock_trade");
    const trades = [];
    bridge.on("on_stock_trade", (d) => trades.push(d));
    // 用 order() 不是 request("order") —— request 只能发 query 帧
    await bridge.order({ code: "sh600000", side: "buy", volume: 100, price: 12.34, clientOrderId: "u1" }, 2000);
    await first;
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(trades.length, 2, "桥那边确实推了两次（这是 xtquant 的真实行为）");
    const seen = new Set(trades.map((t) => t.tradedId));
    assert.equal(seen.size, 1, "但 tradedId 相同 —— 靠它去重就能认出是同一条");
  });
});

// ── 5. 崩溃恢复：报单了但状态没写回盘 ──────────────────────────

test("重启后有未对齐的旧委托 → 先查券商对齐，不许直接开新仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-recover-"));
  {
    // 盘上那单的状态是 pending（上报出去了，回写了一半）
    const order = {
      orderId: "o-recover-1",
      brokerOrderId: 8888,
      accountId: "TEST001",
      code: "sh600000",
      side: "buy",
      volume: 100,
      price: 12.34,
      orderType: "limit",
      style: "rebound",
      intent: "open",
      status: "pending",
      signalKey: signalKey({ tradingDate: "2026-10-08", style: "rebound", code: "sh600000", plannedEntry: 12.34, intent: "open" }),
      attempt: 1,
      plannedEntry: 12.34,
      plannedStop: 9.25,
      plannedTarget: 14.8,
      createdAt: 1,
      updatedAt: 2,
    };
    const orders = [order];
    assert.equal(needsReconcile(orders).length, 1, "pending 的单重启后必须先对齐");

    // 桥也报告有未对齐的委托
    const bridge = createBridge({
      pythonPath: PYTHON,
      scriptPath: FAKE,
      timeoutMs: 2000,
      // 桥启动时报告「有 1 单未对齐」——这是崩溃重启场景的关键输入
      env: { FAKE_MODE: "normal", FAKE_PENDING_ON_START: "1" },
      init: { sessionId: "t", userdataPath: "D:\\fake", accountId: "TEST001" },
    });
    bridge.start();
    try {
      const ready = await waitFor(bridge, "ready");
      assert.equal(ready.unreconciled.length, 1, "桥侧说有 1 单未对齐");
      assert.equal(ready.unreconciled[0].brokerOrderId, 8888);

      // 对齐动作：查券商的真实委托
      const real = await bridge.request("orders", {}, 2000);
      assert.equal(real.orders[0].brokerOrderId, 8888, "券商那边确实有这单");
      assert.equal(real.orders[0].orderStatus, 50, "状态 50 = 已报待成交");

      // 对齐完才允许开新仓 —— 这一步的顺序是硬要求，不能反
      assert.equal(needsReconcile(orders).length, 1, "对齐完成前，这单仍算未对齐");
    } finally {
      bridge.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("崩在「已落盘 draft、还没报给券商」→ 重启后认得出这个信号在盘上，不重报", async () => {
  const key = signalKey({ tradingDate: "2026-10-08", style: "rebound", code: "sh600000", plannedEntry: 12.34, intent: "open" });
  const draft = {
    orderId: "o-draft-1",
    brokerOrderId: null,
    accountId: "TEST001",
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
    createdAt: 1,
    updatedAt: 1,
  };
  // 盘上有一单 draft。重启后重新报之前必须先问 signalInFlight。
  const orders = [draft];
  const inFlight = orders.find((o) => o.signalKey === key && ["draft", "pending", "partial", "unknown"].includes(o.status));
  assert.ok(inFlight, "必须认出这个信号已经在盘上 —— 否则重报就有两笔了");
  assert.equal(inFlight.orderId, draft.orderId);
  assert.equal(needsReconcile(orders).length, 0, "draft 不需要查券商（没报出去过），但需要被幂等挡住");

  // 关键证据：**桥那边一份 order 都没收到**。
  // 这条断言把「崩溃点在报单之前」变成了可验证的事实，而不是一句注释。
  // 如果哪天有人把落盘顺序改成「先报单后落盘」，这里会立刻红。
  const dir = mkdtempSync(join(tmpdir(), "chiheng-nolog-"));
  const logPath = join(dir, "protocol.log");
  const bridge = createBridge({
    pythonPath: PYTHON,
    scriptPath: FAKE,
    timeoutMs: 2000,
    env: { FAKE_MODE: "normal", FAKE_LOG: logPath },
    init: { sessionId: "t", userdataPath: "D:\\fake", accountId: "TEST001" },
  });
  bridge.start();
  try {
    await waitFor(bridge, "ready");
    const sent = readsLog(logPath);
    assert.equal(sent.filter((e) => e.kind === "order").length, 0, "崩溃在报单之前，桥那边不该有任何 order");
    assert.ok(sent.some((e) => e.kind === "init"), "但握手是走过的 —— 说明桥活着，只是没接到单");
  } finally {
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 0. 语法防护 ───────────────────────────────────────────────

/**
 * `.mjs` 是纯 JS，写进去 TypeScript 语法（`import type`、`: string` 返回值标注、
 * 类字段注解 `code: string`、`as T` 断言、`fn<T>()` 泛型实参）在运行时会直接
 * 报语法错误。这个错我连犯三次，每次都是「本地跑一下才发现」，所以钉一条测试。
 */
test("scripts 下所有 .mjs 都得是真 JS（.mjs 里写 TS 语法会在这里被抓住）", () => {
  const dir = "scripts";
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length > 10, `只找到 ${files.length} 个 .mjs，目录读到了吗`);
  const bad = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", join(dir, file)], { stdio: "pipe" });
    } catch (err) {
      bad.push(`${file}: ${String(err.stderr ?? err.message).split("\n").find((l) => l.includes("Error")) ?? "语法错"}`);
    }
  }
  assert.deepEqual(bad, [], `这些 .mjs 有语法错：\n${bad.join("\n")}`);
});
