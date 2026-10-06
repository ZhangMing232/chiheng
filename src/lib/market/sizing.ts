/**
 * 这个文件是干什么的：
 * 算出每一笔买多少股。接实盘必须有这个——现在系统里没有仓位概念，
 * positions.ts 是 `items.length * 100` 硬编码一手，账本只是「名义金额」。
 *
 * 纯函数，不碰 node:fs，能搬进小程序。
 *
 * 几条不能省的规矩：
 * 1. 买入必须是 100 股（1 手）的整数倍，零股不能买。卖出可以是 0（全部卖出）。
 * 2. 算出来的数量不能超过剩余额度，也不能因为额度太小就变成 0 仍然报单
 *    ——额度不够就返回 0，调用方要**跳过这一笔**，不是买 0 股。
 * 3. 预留已挂但没成交的金额。只算已成交的话，挂出去的票不算额度，
 *    连续报单会把钱超发——这是最容易被忽略的一种超发。
 */

export type SizingInput = {
  /** 账户总资产（元）。用券商的 total_asset，不用本地算的。 */
  totalAsset: number;
  /** 单笔最大占比，如 0.1 = 10%。这个是硬上限。 */
  maxPctPerTrade: number;
  /** 允许同时持有几只。用来把「总额度」切成「每笔额度」。 */
  maxPositions: number;
  /** 已经占掉的金额：已成交的持仓成本 + 未成交挂单的预估金额。 */
  usedAmount: number;
  /** 当前价（算金额用） */
  price: number;
  /** A 股 1 手 = 100 股 */
  lotSize?: number;
};

export const MAX_SINGLE_PCT = 0.1;
export const MAX_POSITIONS_DEFAULT = 10;

export function sizeOf(input: SizingInput): number {
  const lot = input.lotSize ?? 100;
  const positions = Math.max(1, input.maxPositions);

  if (!(input.totalAsset > 0) || !(input.price > 0)) return 0;

  // 每笔额度 = 总资产 × 单笔占比，同时不许超过总额度里还没用掉的那份
  const perTrade = input.totalAsset * input.maxPctPerTrade;
  const totalRoom = Math.max(0, input.totalAsset - Math.max(0, input.usedAmount));
  // 总额度还要除以持仓只数——不然 10 只全满之后还能再买满一整个账户
  const room = Math.max(0, Math.min(perTrade, totalRoom / positions));

  // 额度小到买不下一手就返回 0，意思是「这一笔买不了」。
  // 调用方看到 0 要**跳过**，不能硬凑一手、也不能报 0 股（那是废单）。
  return Math.floor(room / input.price / lot) * lot;
}

/**
 * 把券商持仓折算成总市值口径，用于占用额度。
 * 单独抽出来是因为它有两个坑：
 * 1. 要用**成本价**（avgPrice）算占用，不是现价——占用是成本概念
 * 2. T+1 锁定的部分（canUseVolume < volume）也占着钱，只是不算可卖
 */
export function usedByPositions(
  positions: { volume: number; avgPrice: number }[],
  pendingOrders: { side: "buy" | "sell"; volume: number; price: number | null; lastPrice: number }[],
): number {
  const held = positions.reduce((sum, p) => sum + p.volume * p.avgPrice, 0);
  // 未成交的买单也占额度：挂出去的钱不是你的了。卖单不占（那是回收）
  const pendingBuy = pendingOrders
    .filter((order) => order.side === "buy")
    .reduce((sum, order) => sum + order.volume * (order.price ?? order.lastPrice), 0);
  return held + pendingBuy;
}

/** 预检：下单前问一遍能不能报。返回原因，通过时 reason 为空串。 */
export function canSubmit(
  input: { volume: number; price: number | null; side: "buy" | "sell"; totalAsset: number },
): { ok: boolean; reason: string } {
  const { volume, price, side, totalAsset } = input;
  if (!(volume > 0)) return { ok: false, reason: "数量为 0，不报单（额度不够就别报，报了也是废单）" };
  if (side === "buy" && volume % 100 !== 0) return { ok: false, reason: `买入 ${volume} 股不是 100 的整数倍` };
  if (side === "buy" && !(totalAsset > 0)) return { ok: false, reason: "查不到账户总资产，不报单" };
  if (side === "buy" && price != null && price * volume > totalAsset) {
    return { ok: false, reason: `这一笔要 ${(price * volume).toFixed(0)} 元，超过账户总资产 ${totalAsset.toFixed(0)} 元` };
  }
  if (price != null && !(price > 0)) return { ok: false, reason: `价格 ${price} 不合法` };
  return { ok: true, reason: "" };
}
