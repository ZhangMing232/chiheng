/**
 * 大盘温度计（2026-11-18）：每天一句话告诉你「今天该不该在场」。
 *
 * 逻辑（全部可回测，不用未来函数——只用当日收盘后可得的数据）：
 * - 用沪深300 收盘价 vs 20 日均线（MA20）+ MA20 自身趋势
 * - 🔴 空仓区：收盘 < MA20 且 MA20 下行 → 熊市，不买
 * - 🟡 观察区：收盘 < MA20 但 MA20 走平/上行 → 可能筑底，试探
 * - 🟢 进攻区：收盘 ≥ MA20 且 MA20 上行 → 转牛，可以进攻
 *
 * 为什么是 20 日线：A 股常用的中期趋势线；不选 5 日（太抖）也不选 60 日（太钝）。
 * 阈值之后会用 300 天历史回测验证——如果它跑不赢躺平，如实改。
 */

/** 一天的温度计读数。 */
export type RegimeDay = {
  date: string;
  close: number;
  ma20: number;
  /** 收盘相对 MA20 的位置（%，>0 = 在线上） */
  aboveMa20Pct: number;
  /** MA20 相对 5 日前的 MA20（趋势方向） */
  ma20SlopePct: number;
  regime: "空仓" | "观察" | "进攻";
};

/**
 * 给定沪深300 收盘序列（按日期升序），逐日算温度计。
 * 前 25 天数据不足（MA20 + slope 需要），返回序列从第 26 天开始。
 */
export function computeRegime(closes: { date: string; close: number }[]): RegimeDay[] {
  const out: RegimeDay[] = [];
  for (let i = 20; i < closes.length; i++) {
    const window = closes.slice(i - 19, i + 1);
    const ma20 = window.reduce((a, x) => a + x.close, 0) / 20;
    const close = closes[i].close;
    // MA20 斜率：和 5 天前的 MA20 比
    if (i - 24 < 0) continue;
    const ma20Prev = closes.slice(i - 24, i - 4).reduce((a, x) => a + x.close, 0) / 20;
    const slope = ma20Prev > 0 ? (ma20 / ma20Prev - 1) * 100 : 0;
    const abovePct = (close / ma20 - 1) * 100;

    let regime: RegimeDay["regime"];
    if (close >= ma20 && slope > 0) regime = "进攻";
    else if (close >= ma20 || slope > 0) regime = "观察";
    else regime = "空仓";

    out.push({ date: closes[i].date, close, ma20, aboveMa20Pct: abovePct, ma20SlopePct: slope, regime });
  }
  return out;
}

/** 今天的读数（最后一天）。 */
export function todayRegime(closes: { date: string; close: number }[]): RegimeDay | null {
  const all = computeRegime(closes);
  return all.length ? all[all.length - 1] : null;
}
