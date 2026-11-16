/**
 * 这个文件是干什么的：
 * 把「前瞻回验」的落档 picks 转成账本买入计划（纯函数，零 IO，直接单测）。
 *
 * 为什么要有它（2026-11-16 用户拍板）：
 * 前瞻回验原先只在自己那一套里算收益（outcomes 里的 tradePct/holdPct），
 * **不进模拟盘账本**——用户看 today 页显示「成交」却在账本里找不到那只票，
 * 问「不然怎么知道收益怎么样」。这条链路补齐：前瞻挑的票也真正买入记账。
 *
 * 关键设计（避免污染现有统计）：
 * 1. **style 用 "relay"**（短线，hold=1），因为 StyleId 是封闭枚举、加新值会
 *    牵连 styleOf 过滤/策略闸/页面分桶；relay 语义最接近（打板短线、次日出）。
 * 2. **variant 固定 "foresight"**：账本里靠 variant 分桶，冠军/挑战者/前瞻三套
 *    互不干扰，判决和净值各算各的。
 * 3. 入场价 = 当日**开盘价**（前瞻规则的买入时点就是次日开盘），不是收盘价——
 *    这是它和 value 等策略的本质差别，写在 fillNote 里可追溯。
 */

/** 前瞻落档的一只 pick（只取买入需要的字段）。 */
export type ForecastPick = {
  code: string;
  name: string;
  /** 选股日收盘价，用来在拿不到开盘价时兜底（并标记出来）。 */
  pickPrice: number | null;
};

/** 一条待写入账本的买入计划。 */
export type ForesightBuy = {
  id: string;
  code: string;
  name: string;
  /** 入场价：当日开盘价；开盘价拿不到时用 pickPrice 兜底并降级标记。 */
  entry: number;
  stop: number | null;
  target: number | null;
  style: "relay";
  variant: "foresight";
  hold: number;
};

/** 前瞻腿专用常量：短线 1 天出（和 relay 的 STYLE_HOLD 一致）。 */
export const FORESIGHT_HOLD = 1;
/** 前瞻腿的止损/目标幅度（%）：打板短线，止损 5%、目标 10%。 */
export const FORESIGHT_STOP_PCT = 5;
export const FORESIGHT_TARGET_PCT = 10;

/**
 * 生成买入计划。
 * @param picks 落档 picks
 * @param openPrices 代码 → 当日开盘价（拿不到的传 null）
 * @param alreadyHeld 账本里已持有（未卖出）的代码，防重复买入
 */
export function planForesightBuys(
  picks: ForecastPick[],
  openPrices: Map<string, number | null>,
  alreadyHeld: Set<string>,
): ForesightBuy[] {
  const out: ForesightBuy[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    if (!p.code || seen.has(p.code) || alreadyHeld.has(p.code)) continue;
    const open = openPrices.get(p.code) ?? null;
    // 没有开盘价就跳过：拿 pickPrice（选股日收盘）当买入价是假成交——
    // 前瞻规则明确「次日开盘买入」，价格不对就是错的价，宁可今天不记。
    if (open == null || !(open > 0)) continue;
    seen.add(p.code);
    out.push({
      id: p.code,
      code: p.code.replace(/^(sh|sz|bj)/i, ""),
      name: p.name,
      entry: open,
      stop: Math.round(open * (1 - FORESIGHT_STOP_PCT / 100) * 100) / 100,
      target: Math.round(open * (1 + FORESIGHT_TARGET_PCT / 100) * 100) / 100,
      style: "relay",
      variant: "foresight",
      hold: FORESIGHT_HOLD,
    });
  }
  return out;
}

/** 判断一笔账本交易是不是前瞻腿（页面/统计分桶用）。 */
export function isForesightTrade(trade: { variant?: string | null }): boolean {
  return trade.variant === "foresight";
}
