/**
 * 这个文件是干什么的：
 * 实盘执行器。把「模拟盘记下的信号」按真实资金规模转成下单指令，经人工确认后报给券商。
 *
 * 它是把前面那些零件真正装到车上的那一环：`orders.ts`（状态机 + 幂等键）、
 * `sizing.ts`（算买多少股）、`reconcile.ts`（账本 vs 券商对账）、
 * `order-store.mjs`（落盘 + 崩溃重放）、`qmt-bridge.mjs`（跟 QMT 说话）。
 * 这五样此前都写好了、也都测了，但**生产调用点是 0**——零件齐全，没装车。
 *
 * 你需要知道的（三条，都是会伤到钱的）：
 *
 * 1. **落盘必须先于报单。** 整条链路最关键的一个顺序：
 *    先 `appendOrder(status="draft")`，再 `bridge.order()`，拿到券商委托号之后
 *    才 `appendOrder(status="pending")`。
 *    反过来做的话，崩在「报出去了但状态没写回盘」这个缝里，重启会重复下单。
 *    这个不变量已经被 test-bridge-contract.mjs 钉住了（崩溃在报单之前，
 *    桥那边不该有任何 order）。
 *
 * 2. **默认 dry-run，不报单。** 要真报单必须显式 `--confirm`。
 *    这是半自动闸门：策略还没有证明能赚钱的时候，不能让人一按回车就把钱送出去。
 *    dry-run 只打印「本来要报什么、各买多少股、为什么」，够了就再自己确认。
 *
 * 3. **对账不过就停手，不开新仓。** 券商持仓和账本对不上（数量不一致、
 *    券商有账本没有、账本有券商没有）意味着「不知道手里到底有什么」——
 *    这种情况下继续开仓，风险敞口是看不见的。只有成本价漂移不挡（那是费用差异）。
 *
 * 另外，`unknown` 是这套状态机的核心：断线之后状态不明**不许猜**。
 * 猜错的后果是重复下单或漏掉止损，比「停下来等一下」严重得多。
 *
 * 跑法：
 *   npm run trade:dry      # 只看待发单，不报单（默认）
 *   npm run trade:live     # 真报单
 *   FAKE_MODE=die_on_start node ... scripts/live-trader.ts   # 演故障
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// cwd 陷阱：order-store / book-file / rules-file 全按 process.cwd() 拼 data 路径。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);

import { createBridge } from "./qmt-bridge.mjs";
import { appendFill, appendOrder, dedupeFills, latestOrders, readFills, signalInFlight } from "./order-store.mjs";
import { canTransition, isOpen, needsReconcile, signalKey } from "../src/lib/market/orders.ts";
import { MAX_POSITIONS_DEFAULT, MAX_SINGLE_PCT, canSubmit, sizeOf, usedByPositions } from "../src/lib/market/sizing.ts";
import { describeDiff, diffPositions, lotsFromTrades } from "../src/lib/market/reconcile.ts";
import { hardGate } from "../src/lib/market/journal-book.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { OWNER_ID, readUserBook } from "../src/lib/market/book-file.ts";
import { holdOf } from "../src/lib/market/strategies.ts";

/** 桥脚本。默认假桥——真桥要等 Windows + QMT 就位，切过来只改这一行。 */
const DEFAULT_BRIDGE = "scripts/fake-bridge.py";
/**
 * 模拟盘断言的预期总资产。握手时发给 Python，它连上后查一次真实资产，
 * 差超过 2 倍就自己退出并报 fatal。这条不依赖代码、只依赖账户实际状态，
 * 是唯一能挡住「在 QMT 客户端上手动切到实盘」的办法（代码里的开关挡不住手）。
 */
const DEFAULT_EXPECTED_ASSET = 1_000_000;

type Args = {
  confirm: boolean;
  /** 明知账本和券商对不上也要继续报单。演练/冷启动用，会大声警告。 */
  skipReconcile: boolean;
  bridgePath: string;
  expectedAsset: number;
  fakeMode: string | null;
  accountId: string;
};

function parseArgs(argv: string[]): Args {
  const has = (flag: string) => argv.includes(flag);
  const value = (flag: string, fallback: string) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  return {
    confirm: has("--confirm"),
    skipReconcile: has("--skip-reconcile"),
    bridgePath: value("--bridge", DEFAULT_BRIDGE),
    expectedAsset: Number(value("--expected-asset", String(DEFAULT_EXPECTED_ASSET))),
    fakeMode: value("--fake", "") || null,
    accountId: value("--account", "paper-account"),
  };
}

/**
 * 查询失败就停手退出，不往上抛。
 *
 * 为什么不能让异常冒泡：顶层的 unhandled rejection 会把整个进程打死。
 * **崩不是停手**——崩的时候没人知道在途的单是什么状态，也没机会打印原因。
 * 而这里最要紧的恰恰是超时：桥卡住时它不死也不说话，请求一直等到超时，
 * 那种情况下「交易所里到底有没有这单」是不知道的。**不许猜，也不许继续开仓。**
 */
async function safeQuery(bridge: ReturnType<typeof createBridge>, op: string, payload: Record<string, unknown> = {}) {
  try {
    return await bridge.request(op, payload);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[停手] 查询 ${op} 失败：${code} ${message}`);
    if (code === "TIMEOUT") {
      console.error("  状态不明——不许猜，也不许继续开仓。先查券商侧真实状态。");
    }
    bridge.stop();
    process.exit(1);
  }
}

/** 从账本今天的记录里取「还没卖出的」当候选信号。执行器不自己选股。 */
async function todayCandidates(tradingDate: string) {
  const book = await readUserBook(OWNER_ID);
  const day = (book.days ?? []).find((d) => d.date === tradingDate);
  if (!day) return [];
  return (day.trades ?? [])
    .filter((t) => t.exit == null)
    .map((t) => ({
      code: t.id,
      style: t.style ?? "rebound",
      plannedEntry: t.entry,
      plannedStop: t.stop ?? t.entry * 0.75,
      plannedTarget: t.target ?? t.entry * 1.2,
      hold: holdOf(t.style),
    }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tradingDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  console.log(
    `实盘执行器  ${tradingDate}  ${args.confirm ? "【真报单】" : "【dry-run，不报单】"}\n` +
      `  桥：${args.bridgePath}${args.fakeMode ? `（FAKE_MODE=${args.fakeMode}）` : ""}\n`,
  );

  if (!existsSync(join(ROOT, args.bridgePath))) {
    console.error(`桥脚本不存在：${args.bridgePath}`);
    process.exit(1);
  }

  const bridge = createBridge({
    scriptPath: join(ROOT, args.bridgePath),
    init: {
      sessionId: `chiheng-${tradingDate}`,
      accountId: args.accountId,
      accountType: "STOCK",
      expectedTotalAsset: args.expectedAsset,
    },
    env: args.fakeMode ? { FAKE_MODE: args.fakeMode } : undefined,
  });

  let stopTrading = false;
  bridge.on("fatal", (info) => {
    stopTrading = true;
    console.error(`\n[桥挂了] ${info.message} → 停止一切下单。`);
  });
  bridge.on("on_disconnected", (data) => {
    console.error(`\n[断线] ${data.reason ?? "未知原因"}：在途单转 unknown，不许重报。`);
  });
  bridge.on("stderr", (text) => {
    const line = String(text).trim();
    if (line) console.error(`  [py] ${line}`);
  });

  bridge.start();
  // 等握手。canTrade 比 isAlive 严：活着但没握手完也不许下单。
  await new Promise((resolve) => {
    const done = () => resolve(null);
    const offReady = bridge.on("ready", done);
    const offFatal = bridge.on("fatal", done);
    setTimeout(() => {
      offReady();
      offFatal();
      resolve(null);
    }, 5000);
  });

  if (stopTrading || !bridge.canTrade()) {
    console.error("桥没握手完成，不查任何东西，直接退出。");
    bridge.stop();
    process.exit(1);
  }

  // ── 查资产（模拟盘断言的一道：数量级不符就停）──────────────────
  const asset = await safeQuery(bridge, "asset");
  const totalAsset = Number(asset?.totalAsset ?? 0);
  if (!(totalAsset > 0)) {
    console.error("查不到账户总资产，不下单。");
    bridge.stop();
    process.exit(1);
  }
  console.log(`账户总资产 ${totalAsset.toFixed(2)} 元（握手时声明的预期 ${args.expectedAsset}）`);
  if (totalAsset > args.expectedAsset * 2) {
    console.error(
      `\n[停手] 实际总资产 ${totalAsset.toFixed(0)} 超过声明预期 ${args.expectedAsset} 的两倍。\n` +
        `  这意味着连上的很可能不是那个模拟盘账户。不报任何单。`,
    );
    bridge.stop();
    process.exit(1);
  }

  // ── 重启恢复：先把上次没对齐的单问清楚 ─────────────────────────
  const orders = latestOrders();
  const unsettled = needsReconcile(orders);
  if (unsettled.length > 0) {
    console.error(
      `\n[先对齐] 有 ${unsettled.length} 笔单处于 pending/partial/unknown，` +
        `必须先向券商查真实状态，不许「大概是 pending」就重报：`,
    );
    for (const order of unsettled) {
      console.error(`  - ${order.orderId} ${order.code} ${order.status}（券商委托号 ${order.brokerOrderId ?? "无"}）`);
    }
    bridge.stop();
    process.exit(1);
  }

  // ── 对账：券商持仓 vs 账本 ─────────────────────────────────────
  const brokerPositions = await safeQuery(bridge, "positions");
  const list = Array.isArray(brokerPositions) ? brokerPositions : (brokerPositions?.positions ?? []);
  const book = await readUserBook(OWNER_ID);
  // 账本没有 lotId，用 id 顶替（一只票只有一笔时够用；分批建仓会算错，这是已知缺口）。
  // 股数也是假的：模拟盘记的是「名义金额」，根本没有真实持仓数量（positions.ts 是
  // items.length × 100 硬编码）。所以这里的对账在模拟盘阶段只能看个方向，
  // 真正有意义要等账本记上真实 volume（orders.ts 里 Order.volume 已经在做这件事）。
  const ledger = lotsFromTrades(book.days ?? [], () => 100);
  const recon = diffPositions(list, ledger);
  if (recon.diffs.length > 0) {
    console.log(`\n对账差异 ${recon.diffs.length} 条：`);
    for (const diff of recon.diffs) console.log(`  - ${describeDiff(diff)}`);
  }
  if (recon.blocking && args.confirm && !args.skipReconcile) {
    console.error("\n[停手] 数量对不上意味着不知道手里到底有什么，不开新仓。");
    console.error("  （要用演练/冷启动场景强行继续，加 --skip-reconcile，后果自负。）");
    bridge.stop();
    process.exit(1);
  }
  if (recon.blocking && args.confirm && args.skipReconcile) {
    // 过渡期专用：模拟盘账本有记录、券商侧还没有对应持仓，这时真报单必然不一致。
    // 这个开关不是「忽略问题」，是「明知对不上、由人决定继续」——所以必须大声说。
    console.error(
      "\n[警告] --skip-reconcile 已开启：账本和券商对不上也要继续报单。\n" +
        "  这只适合演练，或首次接入真实账户的冷启动。正常跑不要开——\n" +
        "  对不上账意味着不知道手里到底有什么，风险敞口是看不见的。",
    );
  }
  if (recon.blocking && !args.confirm) {
    // dry-run 不挡：模拟盘的账本本来就没有对应的真实券商持仓，「账本有券商没有」是必然的，
    // 不是事故。真报单（--confirm）时才挡——那时券商侧必须有对应的票。
    console.log(
      "\n（dry-run：上面这些差异不挡路。模拟盘账本本来就没有真实券商持仓，对不上是预期的。" +
        "真报单时同样的差异会直接停手。）",
    );
  }

  // ── 风控硬闸 ──────────────────────────────────────────────────
  const rules = await readRules();
  const closed = (book.days ?? []).flatMap((day) =>
    (day.trades ?? [])
      .filter((t) => t.exit != null)
      .map((t) => ({ date: t.exitDate ?? day.date, ret: ((t.exit as number) - t.entry) / t.entry })),
  );
  const hard = hardGate(closed, rules);
  if (!hard.ok) {
    console.error(`\n[停手] 硬闸拦下：${hard.reason}`);
    bridge.stop();
    process.exit(1);
  }
  console.log(`硬闸放行（已结 ${closed.length} 笔）`);

  // ── 候选信号 → 待发单 ─────────────────────────────────────────
  const candidates = await todayCandidates(tradingDate);
  if (candidates.length === 0) {
    console.log("\n今天没有候选信号。");
    bridge.stop();
    process.exit(0);
  }

  const pendingBuy = orders.filter((o) => isOpen(o)).map((o) => ({
    side: o.side,
    volume: o.volume,
    price: o.price,
    lastPrice: o.plannedEntry,
  }));
  /**
   * 占用额度要**在本轮里滚动累加**。
   *
   * 不能每笔都用同一个 usedAmount 去算：那样 20 个候选会各自以为「只占用了这么多」，
   * 于是每笔都按 10% 上限买满，加起来能买出两倍总资产——第一次 dry-run 就报出了
   * 183 万 > 100 万。额度是个池子，排前面的先舀，舀完后面的就该是 0（买不了）。
   */
  let usedAmount = usedByPositions(list, pendingBuy);
  const initialUsed = usedAmount;

  console.log(`\n候选 ${candidates.length} 个，起始占用额度 ${initialUsed.toFixed(0)} 元\n`);
  console.log("  代码        策略      计划买入   股数     金额      预检");

  const plan: { order: Parameters<typeof appendOrder>[0]; reason: string }[] = [];
  for (const cand of candidates) {
    const key = signalKey({
      tradingDate,
      style: cand.style,
      code: cand.code,
      plannedEntry: cand.plannedEntry,
      intent: "open",
    });
    if (signalInFlight(orders, key)) {
      console.log(`  ${cand.code}  ${cand.style}   跳过：这个信号已经在途中`);
      continue;
    }
    const volume = sizeOf({
      totalAsset,
      maxPctPerTrade: MAX_SINGLE_PCT,
      maxPositions: MAX_POSITIONS_DEFAULT,
      usedAmount,
      price: cand.plannedEntry,
    });
    const check = canSubmit({ volume, price: cand.plannedEntry, side: "buy", totalAsset });
    console.log(
      `  ${cand.code}  ${String(cand.style).padEnd(8)} ${cand.plannedEntry.toFixed(2).padStart(8)}` +
        ` ${String(volume).padStart(6)} ${(volume * cand.plannedEntry).toFixed(0).padStart(8)}` +
        `  ${check.ok ? "可报" : check.reason}`,
    );
    if (volume === 0 || !check.ok) continue;
    // 这一笔算进占用，后面的候选看到的额度就少了（额度是个池子，不是每笔独立上限）
    usedAmount += volume * cand.plannedEntry;
    plan.push({
      order: {
        orderId: randomUUID(),
        brokerOrderId: null,
        accountId: args.accountId,
        code: cand.code,
        side: "buy",
        volume,
        price: cand.plannedEntry,
        orderType: "limit",
        style: cand.style,
        intent: "open",
        status: "draft",
        signalKey: key,
        attempt: 1,
        plannedEntry: cand.plannedEntry,
        plannedStop: cand.plannedStop,
        plannedTarget: cand.plannedTarget,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      reason: check.reason,
    });
  }

  if (!args.confirm) {
    console.log(
      `\n[dry-run] 本可报 ${plan.length} 笔，合计 ${plan
        .reduce((s, p) => s + p.order.volume * (p.order.price ?? 0), 0)
        .toFixed(0)} 元。**没有向券商发任何东西。**\n` +
        `  要真报单就加 --confirm。`,
    );
    bridge.stop();
    process.exit(0);
  }

  // ── 报单。顺序不能反：先落 draft，再报，拿到号再落 pending ──────
  console.log("");
  let submitted = 0;
  for (const { order } of plan) {
    if (!bridge.canTrade()) {
      console.error(`桥不可用，停止后续报单（之前已报 ${submitted} 笔）。`);
      break;
    }
    try {
      // ① 先落盘 draft。崩在这一步之后、报单之前 → 重启看到 draft，
      //    走 needsReconcile 去券商查，绝对不重报。
      appendOrder(order);
      // ② 报单
      const resp = await bridge.order({
        code: order.code,
        side: order.side,
        volume: order.volume,
        orderType: order.orderType,
        price: order.price,
        signalKey: order.signalKey,
        clientOrderId: order.orderId.slice(0, 20),
        strategyName: `chiheng_${order.style}`,
      });
      const brokerOrderId = Number(resp?.brokerOrderId ?? 0);
      // ③ 拿到委托号，落 pending
      order.brokerOrderId = brokerOrderId > 0 ? brokerOrderId : null;
      order.status = "pending";
      order.updatedAt = Date.now();
      appendOrder(order);
      submitted += 1;
      console.log(`  已报 ${order.code} ${order.volume} 股 @ ${order.price}（券商委托号 ${order.brokerOrderId ?? "无"}）`);
    } catch (err) {
      // 报单失败（含超时）。**超时的单状态不明，必须当 unknown 处理**，
      // 不能当成失败就重报——重报就是重复下单。
      const code = err?.code ?? "UNKNOWN";
      const message = err?.message ?? String(err);
      const to: "unknown" | "rejected" = code === "TIMEOUT" ? "unknown" : "rejected";
      if (canTransition(order.status, to)) {
        order.status = to;
        order.updatedAt = Date.now();
        appendOrder(order);
      }
      console.error(`  [失败] ${order.code}：${code} ${message} → 记为 ${to}${to === "unknown" ? "（重启后先查券商）" : ""}`);
    }
  }

  // ── 成交回报：去重后落盘 ───────────────────────────────────────
  bridge.on("on_stock_trade", (data) => {
    const fill = {
      fillId: String(data.tradedId ?? `${data.brokerOrderId}-${Date.now()}`),
      orderId: "",
      brokerOrderId: Number(data.brokerOrderId ?? 0),
      code: String(data.code ?? ""),
      side: data.side ?? "buy",
      volume: Number(data.tradedVolume ?? 0),
      price: Number(data.tradedPrice ?? 0),
      amount: Number(data.tradedAmount ?? 0),
      filledAt: Date.now(),
    };
    // 同一条回报可能因断线重连被推多次。fillId 是天然的幂等键，重复的直接丢。
    const { duplicates } = dedupeFills([...readFills(), fill]);
    if (duplicates > 0) {
      console.log(`  成交回报 ${fill.fillId} 重复推送，已跳过`);
      return;
    }
    appendFill(fill);
    console.log(`  成交 ${fill.code} ${fill.volume} 股 @ ${fill.price}`);
  });

  console.log(`\n本轮结束。订单日志 ${process.env.CHIHENG_DATA_DIR ?? "data"}/orders.jsonl`);
  setTimeout(() => bridge.stop(), 1500);
}

await main();
