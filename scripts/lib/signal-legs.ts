/**
 * 两条腿的「什么时候走」——单一出处，别在推送文案里再硬编码一遍。
 *
 * 短线 5 个交易日：回测登记版 evt-themeLaggard 的 hold（scripts/backtest.ts:997）。
 * 中长线 8 个交易日：早盘推送原本写在纪律行里的口径。
 *
 * 口径（用户 2026-11-10 点名要「什么时候走」）：买入日算第 1 日，
 * 第 N 个交易日收盘走；中途打到止损或目标，先到先走。
 * T+1 铁律不变——买入当天不卖。
 *
 * 这里**不写具体日历日期**：交易日受节假日影响，用周末近似算出来的日期
 * 会错，错日期比不给日期更坏。给「第 N 日 + 规则」，人自己能对上日历。
 */
export type Leg = "short" | "long";

export const LEG_HOLD_DAYS: Record<Leg, number> = { short: 5, long: 8 };

/** 旧候选文件没有 leg 字段时按策略名回退（热点·题材补涨 = 短线）。 */
export function legOf(s: { leg?: Leg; strategy?: string }): Leg {
  if (s.leg === "short" || s.leg === "long") return s.leg;
  return (s.strategy ?? "").startsWith("热点") ? "short" : "long";
}

/** 新候选自带 holdDays 优先；旧文件按腿回退，不会把「没有字段」当成 0 天。 */
export function holdDaysOf(s: { leg?: Leg; strategy?: string; holdDays?: number }): number {
  const own = s.holdDays;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return Math.round(own);
  return LEG_HOLD_DAYS[legOf(s)];
}

/** 推送每行末尾的走人字段。 */
export function exitTextOf(s: { leg?: Leg; strategy?: string; holdDays?: number }): string {
  return `走 第${holdDaysOf(s)}日`;
}

/**
 * 「今天到底按什么价下单」——报给你的价必须是能成交、且不追高的价。
 *
 * 为什么不是挂价（2026-11-12 用户两次指出）：挂价＝昨收，等于要求今天跌回昨天的价。
 * 实测 20 笔只成交 9 笔（45%），今天 8 条只 2 条——报一个全天没出现过的价，
 * 挂着也买不到，那不是建议。
 *
 * 也不是死板照搬竞价价：竞价高开 13% 还按竞价买，那是追高（连板追高 −3.71% 已证伪）。
 *
 * 规则（简单、可解释）：
 *   竞价 ≤ 昨收 × 1.02  → 下单价＝竞价价（挂得上，开盘即成交）
 *   竞价 > 昨收 × 1.02  → 今天不买（高开超过 2%，不追）
 *   竞价还没出来        → 退回昨收价，并标明「未竞价」
 * 止损/目标按原来的相对距离一起平移，不因为换了价位就变成另一个风险敞口。
 */
export const CHASE_CAP = 0.02;

export function orderPriceOf(s: {
  buyPrice: number;
  auctionPrice?: number | null;
  stop?: number | null;
  target?: number | null;
}): { price: number | null; skipReason: string | null; stop: number | null; target: number | null; pending: boolean } {
  const base = s.buyPrice;
  const au = s.auctionPrice;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const stopPct = s.stop != null && base > 0 ? s.stop / base - 1 : null;
  const targetPct = s.target != null && base > 0 ? s.target / base - 1 : null;

  let price: number | null;
  let skipReason: string | null = null;
  let pending = false;
  if (au == null || !(au > 0)) {
    price = base;
    pending = true;
  } else if (au <= base * (1 + CHASE_CAP)) {
    price = au;
  } else {
    price = null;
    skipReason = `竞价 ${au} 比昨收 ${base} 高 ${(((au - base) / base) * 100).toFixed(1)}%，超过 ${(CHASE_CAP * 100).toFixed(0)}% 不追`;
  }
  return {
    price: price == null ? null : r2(price),
    skipReason,
    stop: price != null && stopPct != null ? r2(price * (1 + stopPct)) : (s.stop ?? null),
    target: price != null && targetPct != null ? r2(price * (1 + targetPct)) : (s.target ?? null),
    pending,
  };
}

/** 一张单子的四个必答：买多少、亏到哪走、赚到哪走、什么时候走。两腿推送共用，别各写一份。 */
export function orderFieldsOf(s: {
  leg?: Leg;
  strategy?: string;
  holdDays?: number;
  buyPrice: number;
  auctionPrice?: number | null;
  stop?: number | null;
  target?: number | null;
}): string {
  const o = orderPriceOf(s);
  if (o.price == null) return `今天不买 —— ${o.skipReason ?? "竞价过高"}`;
  const tag = o.pending ? "（未竞价，按昨收）" : "";
  return `买 ${o.price}${tag} | 止损 ${o.stop ?? "—"} | 目标 ${o.target ?? "—"} | ${exitTextOf(s)}`;
}
