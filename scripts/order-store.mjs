/**
 * 这个文件是干什么的：
 * 订单的落盘和读取。JSONL 追加，append-only。
 *
 * 为什么不用 SQLite：
 * node:sqlite 在 Node 22 还是实验特性；而且订单模型（src/lib/market/orders.ts）
 * 要保持纯函数好搬进小程序，落盘这层单独放在 scripts/ 里。JSONL 追加天然幂等，
 * 写到一半崩了不会毁掉已有行——账本用 JSON 文件时踩过这个坑
 * （book-file.ts:71-73：「坏文件会被当成没有账而整本消失」）。
 * 订单量在几千条级别，启动时全量重放完全可接受。
 *
 * 崩溃安全的关键顺序在 report() 里写成了注释，别改。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// 不要 import type：这是纯 .mjs，TypeScript 的类型语法在运行时是语法错误。
// Order / Fill 的形状在下面用 JSDoc 标一下，够读懂就行，类型检查交给 orders.ts 本身。
/** @typedef {import("../src/lib/market/orders.ts").Order} Order */
/** @typedef {import("../src/lib/market/orders.ts").Fill} Fill */

/**
 * 订单日志目录。默认项目下的 data/，CHIHENG_DATA_DIR 可以改。
 *
 * 这道检查是被真实事故逼出来的：测试里某次异步 activity 在测试结束后才跑，
 * 那时环境变量已经被脚手架还原了，于是订单写进了**真实的** data/orders.jsonl。
 * 现在跑测试时不给 CHIHENG_DATA_DIR 就直接拒绝启动——
 * 测试数据污染真账本比测试失败严重得多：账本是唯一的，没有版本控制。
 */
function dataDir() {
  const dir = process.env.CHIHENG_DATA_DIR;
  if (!dir && process.env.NODE_ENV === "test") {
    throw new Error(
      "订单落盘在测试环境里必须显式指定 CHIHENG_DATA_DIR。" +
        "不允许默认写进项目的 data/——那是真账本，测试数据混进去没法清理。",
    );
  }
  return dir ?? join(process.cwd(), "data");
}
function ordersPath() {
  return join(dataDir(), "orders.jsonl");
}
function fillsPath() {
  return join(dataDir(), "fills.jsonl");
}

/** @template T @param {string} path @returns {T[]} */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  /** @type {T[]} */
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // 崩溃时写了一半的那行。跳过——一行坏数据不该把整份记录废掉。
    }
  }
  return out;
}

/**
 * 记一笔订单状态变化。**每次状态变化追加一条，不覆盖。**
 * 这样崩溃后能看到完整的轨迹，包括「报过但状态没来得及更新」的那种。
 */
/** @param {Order} order */
export function appendOrder(order) {
  try {
    appendFileSync(ordersPath(), `${JSON.stringify({ ...order, _seq: Date.now() })}\n`, "utf8");
  } catch (err) {
    // 这里不能静默——订单落盘失败意味着崩溃后无法恢复，下单可能重复。
    // 但也不能抛出去把整个循环打挂：先大声报，让上层决定停不停。
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[orders] 订单落盘失败：${message}（这条单可能无法恢复，重复下单风险）`);
    throw err;
  }
}

/** @param {Fill} fill */
export function appendFill(fill) {
  appendFileSync(fillsPath(), `${JSON.stringify(fill)}\n`, "utf8");
}

/** @returns {Order[]} */
export function readOrders() {
  return readJsonl(ordersPath());
}

/** @returns {Fill[]} */
export function readFills() {
  return readJsonl(fillsPath());
}

/**
 * 重放订单日志，得到每张单的最新状态。
 *
 * 为什么要重放而不是直接读最后一条：日志是追加的，同一个 orderId 会有多条
 * （draft → pending → filled）。只取最后一条会在时间戳乱序时出错。
 */
/** @returns {Order[]} */
export function latestOrders() {
  /** @type {Map<string, any>} */
  const byId = new Map();
  // readOrders() 声明成 Order[]，但盘上的行比 Order 多一个 _seq（写入时加的）。
  // 这里显式按 any 处理——重放逻辑要读的就是那个额外字段。
  for (const row of /** @type {any[]} */ (readOrders())) {
    const key = row.orderId;
    if (!key) continue;
    const prev = byId.get(key);
    // 追加日志里同一条单会有多条（draft → pending → filled），取最后写入的那条。
    // 用 _seq 比而不是「数组里最后出现的」——万一时间戳乱序，后者会挑错。
    const seq = row._seq ?? 0;
    const prevSeq = prev?._seq ?? -1;
    if (!prev || seq >= prevSeq) byId.set(key, row);
  }
  return [...byId.values()].map((row) => {
    const { _seq, ...order } = row;
    return order;
  });
}

/** 成交回报去重。同一条回报可能因为断线重连被推送多次。 */
/** @param {Fill[]} fills @returns {{unique: Fill[], duplicates: number}} */
export function dedupeFills(fills) {
  const seen = new Set();
  /** @type {Fill[]} */
  const unique = [];
  let duplicates = 0;
  for (const fill of fills) {
    if (seen.has(fill.fillId)) {
      duplicates += 1;
      continue;
    }
    seen.add(fill.fillId);
    unique.push(fill);
  }
  return { unique, duplicates };
}

/**
 * 下单前的幂等检查：这个 signalKey 是不是已经在路上（未成交也没撤）。
 *
 * 崩溃恢复的另一半：重启后要重报之前，先问这个函数。
 * 报出去但状态没记回来的单，盘上还是 draft，**这个函数救不了你**——
 * 那要靠 needsReconcile() 去券商查。两者缺一不可。
 */
/** @param {Order[]} orders @param {string} signalKey @returns {Order | null} */
export function signalInFlight(orders, signalKey) {
  const open = orders.filter(
    (order) => order.signalKey === signalKey && ["draft", "pending", "partial", "unknown"].includes(order.status),
  );
  return open[0] ?? null;
}
