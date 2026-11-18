/**
 * 这个文件是干什么的：
 * 回测的交易规则约束（2026-11-18）。用户指出「基础交易规则要遵守」——
 * 之前我写的回测犯了两个致命错误，都靠这个文件防住：
 *
 * ❌ 错误 1「未来函数」：用信号日**收盘价**买入。但收盘后才知道信号
 *    （龙虎榜晚上公布、收盘扫描盘后才跑），那个价根本买不到。
 *    → 本文件强制：买入价只能用**信号日之后第一个交易日**的价。
 *
 * ❌ 错误 2「违反 T+1」：当日买入当日卖出。A 股 T+1，当天买的不能当天卖。
 *    → 本文件强制：卖出日期必须 > 买入日期（至少隔一个交易日）。
 *
 * 用法：所有回测/扫描脚本计算收益必须走本文件的函数，不许自己写
 * `(later / now - 1)`。
 */

/** 一根可用的 K 线（只保留回测需要的字段）。 */
export type LegalBar = {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type TradeLegality = {
  ok: boolean;
  /** 不合法时的原因（写给人看） */
  why: string | null;
};

/**
 * 校验一笔交易是否合法（T+1 + 不用未来价）。
 *
 * @param signalDate 产生信号的那天（收盘后才知道）
 * @param buy 买入那根 bar
 * @param sell 卖出那根 bar
 */
export function checkLegality(signalDate: string, buy: LegalBar, sell: LegalBar): TradeLegality {
  // ① 买入必须在信号日之后（信号日当天/之前买入 = 未来函数）
  if (!(buy.date > signalDate)) {
    return { ok: false, why: `买入日 ${buy.date} 不晚于信号日 ${signalDate}——用到了当时拿不到的价格（未来函数）` };
  }
  // ② T+1：卖出日期必须晚于买入日期（同一天卖 = 违规）
  if (!(sell.date > buy.date)) {
    return { ok: false, why: `卖出日 ${sell.date} 不晚于买入日 ${buy.date}——A股 T+1，当天买不能当天卖` };
  }
  return { ok: true, why: null };
}

/**
 * 合法收益计算：信号日之后第一个交易日开盘买 → 之后某日卖。
 * 这是唯一可执行的口径（收盘后得到信号，只能次日开盘操作）。
 *
 * @param signalDate 信号日
 * @param bars 按日期升序的 K 线
 * @param holdDays 买入后持有几个交易日再卖（1 = 次日买、再次日卖，符合 T+1 的最短合法方案）
 * @param exitAt 卖出用开盘价还是收盘价
 * @returns 收益百分比 + 明细；不合法或数据不足返回 null + 原因
 */
export function legalReturn(
  signalDate: string,
  bars: readonly LegalBar[],
  holdDays: number,
  exitAt: "open" | "close" = "open",
): { pct: number; buyDate: string; sellDate: string; buyPrice: number; sellPrice: number } | { pct: null; why: string } {
  const sigIdx = bars.findIndex((b) => b.date === signalDate);
  if (sigIdx < 0) return { pct: null, why: `K 线里没有信号日 ${signalDate}` };

  // 买入 = 信号日之后第一个交易日（T+1 开盘）
  const buyIdx = sigIdx + 1;
  if (buyIdx >= bars.length) return { pct: null, why: "信号日之后没有交易日了" };
  const buy = bars[buyIdx];
  if (!(buy.o > 0)) return { pct: null, why: `买入日 ${buy.date} 无有效开盘价` };

  // 卖出 = 买入日之后第 holdDays 个交易日（holdDays >= 1，满足 T+1）
  const sellIdx = buyIdx + Math.max(1, holdDays);
  if (sellIdx >= bars.length) return { pct: null, why: "持有期超出 K 线范围" };
  const sell = bars[sellIdx];
  const sellPrice = exitAt === "open" ? sell.o : sell.c;
  if (!(sellPrice > 0)) return { pct: null, why: `卖出日 ${sell.date} 无有效价格` };

  const legality = checkLegality(signalDate, buy, sell);
  if (!legality.ok) return { pct: null, why: legality.why ?? "不合法" };

  return {
    pct: (sellPrice / buy.o - 1) * 100,
    buyDate: buy.date,
    sellDate: sell.date,
    buyPrice: buy.o,
    sellPrice,
  };
}

/** 一字涨停买不进：开盘价贴在涨停价、且全天最高也在涨停（没有更低价可成交）。 */
export function limitUpSealed(bar: LegalBar, prevClose: number, limitPct = 10): boolean {
  if (!(prevClose > 0)) return false;
  const up = Math.round(prevClose * (1 + limitPct / 100) * 100) / 100;
  // 一字板 = 开盘就在涨停 且 **全天最低也在涨停**（没人能在这个价以下买到）
  return bar.o >= up - 0.005 && bar.l >= up - 0.005;
}

/** 交易成本（往返）：佣金 + 印花税 + 滑点，按百分比。回测必须扣，否则高估收益。 */
export const ROUND_TRIP_COST_PCT = 0.15;
