/**
 * 成交与费用口径的单一出处（2026-11-10，design/quantmind-borrow-list.md P1-3）。
 *
 * 以前两套账：backtest.ts 里是「手续费 + 滑点」（0.102% + 0.2%），journal-book.ts
 * 里是纯手续费 0.102%（不含滑点）——同一笔交易两个净收益，实盘对账永远高估 0.2%/往返。
 * 现在回测、账本、信号跟踪、竞价审核全从这里取同一套。
 *
 * 数值口径（2026-10-12 在 backtest.ts 核对过的版本，搬移不改数）：
 * - 佣金 万2.5 双边，单笔不满 ¥5 按 ¥5 收（单笔 2 万以下才触发）；
 * - 过户费 万0.1 双边；印花税 万5 卖出单边；
 * - 滑点 单边默认万 10（BT_SLIPPAGE 可调，0 = 关）——**估值不是实测**，
 *   披露里单列，不混进手续费假装硬事实（backtest.ts 披露段的原话）。
 *
 * 整手（100 股）规则：收益率口径的记账按笔记、没有股数，用不上；股数撮合以后做
 * 模拟盘再说。涨跌停幅度唯一出处是 short-forms.ts 的 boardLimitPct。
 *
 * ⚠️ 本文件被页面组件间接引用（journal-book ← positions/paper），env 读取必须
 * 带 typeof process 守卫，浏览器里没有 process。
 */

export const COMMISSION_RATE = 0.00025;
export const COMMISSION_MIN = 5;
export const TRANSFER_FEE = 0.00001;
export const STAMP_TAX = 0.0005;

const envOf = (): Record<string, string | undefined> =>
  typeof process !== "undefined" && process.env ? process.env : {};

/** 滑点（单边）。默认万 10；BT_SLIPPAGE=0 关掉（A/B 对照用）。 */
export const SLIPPAGE = Number(envOf().BT_SLIPPAGE ?? 0.001);

/** 每笔本金。对齐线上：MAX_SINGLE_PCT = 0.1 × 100 万 = 10 万（sizing.ts:31）。 */
export const CAPITAL_PER_TRADE = Number(envOf().BT_CAPITAL ?? 100_000);

/** 纯手续费的一来一回合计（不含滑点）——披露/对照用。 */
export const FEE_ONLY = COMMISSION_RATE * 2 + TRANSFER_FEE * 2 + STAMP_TAX;

/**
 * 一来一回的总成本占买入金额的比例（手续费 + 滑点）。
 * 佣金「单笔不满 ¥5 按 ¥5」单独算：固定费除以本金才占收益比例，不是常数费率。
 */
export function roundTripFee(notional: number = CAPITAL_PER_TRADE): number {
  if (!(notional > 0)) return FEE_ONLY + SLIPPAGE * 2;
  const commission = Math.max(notional * COMMISSION_RATE, COMMISSION_MIN) / notional;
  return commission * 2 + TRANSFER_FEE * 2 + STAMP_TAX + SLIPPAGE * 2;
}

/** 毛收益率 → 净收益率（扣一来一回费用+滑点）。跟踪/对账用。
 *  （journal-book 有自己的 netReturn(entry, exit)，走 ROUND_TRIP_COST=本口径。） */
export function grossToNet(grossRet: number, notional: number = CAPITAL_PER_TRADE): number {
  return grossRet - roundTripFee(notional);
}
