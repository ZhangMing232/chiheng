/**
 * 这个文件是干什么的：
 * 订单的数据模型。一次「委托」（我打算做什么）和一笔「持仓」（账本推导出来的）
 * 是两回事，这个文件只管前者。
 *
 * 为什么不改现有的 Trade：
 * Trade 有四份手抄的重复定义（scripts/record-journal.ts、src/lib/paper.ts、
 * 以及 mp/ 下的两份编译产物），而且它被 lab/positions/journal-book 三个模块
 * 和 147 个测试依赖。给它加数量、账户、订单号会波及一大片——
 * 而接 QMT 需要的是**并行的**一套，不是在旧的上面改。
 * 所以 Trade 保持原样（只加一个可选的 lotId），Order 独立存在。
 *
 * 这个文件是纯类型 + 纯函数，不碰 node:fs，所以能搬进小程序。
 * 落盘那层在 scripts/order-store.mjs。
 */

import type { StyleId } from "./strategies.ts";

/**
 * 委托状态。
 *
 * `unknown` 是这套状态机存在的核心理由：**断线之后状态不明的时候不许猜。**
 * 猜错的后果是重复下单或者漏掉止损，比「停下来等一下」严重得多。
 * 它必须是一个显式状态，而不是「pending 反正也行」——
 * 因为处理方式完全不同：unknown 要先向券商查询真实状态再决定，不能直接重报。
 */
export type OrderStatus =
  | "draft" // 还没报出去。**必须先落盘再报单**，这是崩溃不重复下单的关键
  | "pending" // 已报给券商，等回报
  | "partial" // 部分成交
  | "filled" // 全部成交
  | "canceled" // 已撤
  | "rejected" // 券商拒单（废单）
  | "unknown"; // 断线，状态不明 → 先查询，不猜

/** 这些状态下这单还占着仓位、不能重复报。 */
export const OPEN_STATUSES: OrderStatus[] = ["draft", "pending", "partial", "unknown"];

export type OrderIntent =
  | "open" // 开仓
  | "close" // 平仓
  | "reduce"; // 减仓

export type Order = {
  /** 我们自己生成的 UUID。幂等键，也是在券商侧反查这单的凭据（塞进 order_remark）。 */
  orderId: string;
  /** QMT 返回的委托号。没报出去是 null——null 和 0 要分清，0 不是合法委托号。 */
  brokerOrderId: number | null;
  accountId: string;
  /** 全项目统一用 sh600000 这个格式。转成 QMT 的 600000.SH 是桥接层的事。 */
  code: string;
  side: "buy" | "sell";
  /** 股。A 股买入必须是 100 的整数倍；卖出可以是 0（全部卖出，见 xtquant 约定）。 */
  volume: number;
  /** 限价。null = 市价单 */
  price: number | null;
  orderType: "limit" | "market";
  style: StyleId;
  intent: OrderIntent;
  status: OrderStatus;
  /** 信号幂等键，见 signalKey()。 */
  signalKey: string;
  /** 第几次尝试报这一单。正常应该是 1；大于 1 说明重试过，要能查。 */
  attempt: number;
  /** 计划价。成交价是另一回事，别混。 */
  plannedEntry: number;
  plannedStop: number;
  plannedTarget: number;
  createdAt: number;
  updatedAt: number;
};

/** 一次成交回报。一笔委托可以有 N 条成交。 */
export type Fill = {
  /** 券商的成交编号。天然幂等键——同一条回报可能因为重连被推送多次。 */
  fillId: string;
  orderId: string;
  brokerOrderId: number;
  code: string;
  side: "buy" | "sell";
  volume: number;
  price: number;
  /** 券商给的成交金额。跟 volume × price 可能有微小差异（含费用），用券商的。 */
  amount: number;
  filledAt: number;
};

/** 券商真实持仓。只能从券商查（xtquant 的 query_stock_positions），推不出来。 */
export type BrokerPosition = {
  accountId: string;
  code: string;
  /** 总持仓 */
  volume: number;
  /** 可用。T+1 锁定的部分今天卖不掉，这个数才是能卖的数量。 */
  canUseVolume: number;
  /** 券商的成本价，含费用 */
  avgPrice: number;
  marketValue: number;
};

/**
 * 信号幂等键：同一信号不会产生第二条订单。
 *
 * 为什么不带时间戳：带上就退化成「每次都不同」，幂等失效。
 * 为什么不用 orderId：orderId 在生成之前还不知道。
 *
 * 形态：`${日期}:${策略}:${代码}:${计划买价}:${意图}`
 * 计划买价保留两位小数——浮点数直接拼会有精度尾巴，
 * `12.340000000000001` 和 `12.34` 会被当成两个不同信号，幂等就漏了。
 */
export function signalKey(parts: {
  tradingDate: string;
  style: StyleId;
  code: string;
  plannedEntry: number;
  intent: OrderIntent;
}): string {
  return `${parts.tradingDate}:${parts.style}:${parts.code}:${parts.plannedEntry.toFixed(2)}:${parts.intent}`;
}

/**
 * 状态机：这些转换是合法的，其余的一律拒绝。
 * `partial` 和 `unknown` 不允许「原地不动」——这两个状态都需要外部输入才能推进
 * （新的成交回报 / 券商查询结果），停在原地等于没处理。
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // draft → rejected 也允许：报单当场被拒（废单）也是一种终态
  draft: ["draft", "pending", "rejected", "canceled", "unknown"],
  pending: ["pending", "partial", "filled", "canceled", "rejected", "unknown"],
  partial: ["filled", "canceled", "unknown"],
  filled: [],
  canceled: [],
  rejected: [],
  unknown: ["pending", "partial", "filled", "canceled", "rejected"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isOpen(order: Order): boolean {
  return OPEN_STATUSES.includes(order.status);
}

/** 成交明细折算成剩余未成交量。partial → 已成交多少、还差多少。 */
export function remainingOf(order: Order, fills: Fill[]): number {
  const done = fills
    .filter((fill) => fill.orderId === order.orderId)
    .reduce((sum, fill) => sum + fill.volume, 0);
  return Math.max(0, order.volume - done);
}

/**
 * 重启后要先对齐的订单。
 *
 * **这是崩溃恢复的核心**：报单给券商之后、把状态写回盘之前崩了，
 * 盘上这单还是 draft，但我们不知道券商那边到底收没收到。
 * 唯一安全的做法是重启后先拿这批单去向券商查真实状态，
 * 对齐完才允许开新仓——不许「大概是 pending 吧」就重报一遍。
 */
export function needsReconcile(orders: Order[]): Order[] {
  return orders.filter((order) => order.status === "pending" || order.status === "partial" || order.status === "unknown");
}

/**
 * 从一批订单里找出「已经报过但盘上没记下来」的。
 * 正常情况下 signalKey 唯一就够，但 attempt > 1 的要单独查——
 * 那是重试过的单，历史上可能有重复上报。
 */
export function duplicatesBySignal(orders: Order[]): { signalKey: string; orderIds: string[] }[] {
  const bySignal = new Map<string, string[]>();
  for (const order of orders) {
    const list = bySignal.get(order.signalKey) ?? [];
    list.push(order.orderId);
    bySignal.set(order.signalKey, list);
  }
  const out: { signalKey: string; orderIds: string[] }[] = [];
  for (const [key, ids] of bySignal) {
    if (ids.length > 1) out.push({ signalKey: key, orderIds: ids });
  }
  return out;
}
