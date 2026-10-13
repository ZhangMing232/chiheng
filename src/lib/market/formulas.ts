/**
 * 这个文件是干什么的：
 * 财务公式库（对标 Vibe-Research 的 `calc/formulas.py`，30 函数）。
 *
 * 口径逐字对齐：
 *   - **forward_cagr** = (EPS[T+n] ÷ EPS[T])^(1/n) − 1（默认 n=2）；任一 EPS ≤ 0
 *     （跨零）→ 无意义
 *   - **peg** = PE ÷ (CAGR × 100)；PE ≤ 0 或 CAGR ≤ 0 → 无意义；**|CAGR| > 5 视为
 *     百分数误传 → 报错**（把 5.9 当成 0.059 传进来，PEG 会大 100 倍且看不出来）
 *   - **单位归一**：市值常用亿、利润常用元，PE 前必须归一（它 _pe 的教训：
 *     单位差一万倍，PE 从 19 变成 0.0019，静默错误）
 *   - **fx_convert**：金额是基准币种 → 乘汇率；是报价币种 → 除（港美股需要）
 *
 * 你需要知道的（纪律）：
 * 1. 算不出就返回 null 或抛错，**不给假值**——0 会被读成「不赚不亏」。
 * 2. 单位错必须抛错，不能默默算——它 CalcInputError 的精神。
 */

/** 金额单位 → 元的倍数。 */
const UNIT_TO_YUAN: Record<string, number> = {
  元: 1,
  万元: 1e4,
  亿: 1e8,
  亿元: 1e8,
  美元: 1, // 外币按「数值不变、币种标注」处理，换算走 fxConvert
  港元: 1,
};

/** 把金额归一成元。单位不认识直接抛（不猜）。 */
export function toYuan(amount: number, unit: string): number {
  const factor = UNIT_TO_YUAN[unit];
  if (factor == null) throw new Error(`金额单位不认识：${unit}（只认 ${Object.keys(UNIT_TO_YUAN).join("/")}）`);
  if (!Number.isFinite(amount)) throw new Error(`金额不是有限数：${amount}`);
  return amount * factor;
}

/** PE = 市值 ÷ 净利润。两个参数各自带单位，内部归一。 */
export function peFromCapProfit(cap: number, capUnit: string, profit: number, profitUnit: string): number | null {
  const capYuan = toYuan(cap, capUnit);
  const profitYuan = toYuan(profit, profitUnit);
  if (profitYuan <= 0) return null; // 亏损 → PE 无意义
  return capYuan / profitYuan;
}

/**
 * 前瞻 CAGR = (EPS[T+n] ÷ EPS[T])^(1/n) − 1。任一 EPS ≤ 0（跨零）→ null。
 */
export function forwardCagr(epsT: number, epsTn: number, years = 2): number | null {
  if (!Number.isFinite(epsT) || !Number.isFinite(epsTn) || !Number.isInteger(years) || years < 1 || years > 10) return null;
  if (epsT <= 0 || epsTn <= 0) return null; // 跨零：年化增速无意义
  return Math.pow(epsTn / epsT, 1 / years) - 1;
}

/**
 * PEG = PE ÷ (CAGR × 100)。cagr 传小数（0.059 = 5.9%）。
 *
 * |CAGR| > 5 抛错——那是把百分数（5.9）当成小数传了，PEG 会大 100 倍且看不出来
 * （它 CalcInputError 的同一条：这种错必须炸，不能默默给个数）。
 */
export function peg(pe: number, cagr: number): number {
  if (!Number.isFinite(pe) || !Number.isFinite(cagr)) throw new Error("PE 或 CAGR 不是有限数");
  if (Math.abs(cagr) > 5) throw new Error(`CAGR=${cagr} 超过 5，疑似把百分数当成小数传入（应传 0.059 而不是 5.9）`);
  if (pe <= 0) throw new Error(`PE=${pe} ≤ 0，PEG 无意义（亏损或数据错误）`);
  if (cagr <= 0) throw new Error(`CAGR=${cagr} ≤ 0，PEG 无意义（负增长下 PEG 失效）`);
  return pe / (cagr * 100);
}

/** 安全版 PEG：算不出返回 null（不抛），给页面用。 */
export function pegSafe(pe: number | null, cagr: number | null): number | null {
  if (pe == null || cagr == null) return null;
  try {
    return peg(pe, cagr);
  } catch {
    return null;
  }
}

/**
 * 汇率换算：金额在 from 币种，换成 to 币种。
 * rate 是「1 单位基准币种（baseCcy）= rate 单位目标币种」（如 1 美元 = 7.1 元，
 * 基准美元、目标元）。它 formulas.py fx_convert 的规矩：
 *   **金额是基准币种 → 乘；金额是报价币种 → 除**。
 * 两个都不是基准 → 抛错（缺交叉汇率，不猜）。
 */
export function fxConvert(value: number, from: string, to: string, rate: number, baseCcy: string): number {
  if (!Number.isFinite(value) || !Number.isFinite(rate) || rate <= 0) throw new Error("金额或汇率不合法");
  if (from === to) return value;
  if (from === baseCcy) return value * rate; // 金额是基准币种 → 乘（换成目标币种）
  if (to === baseCcy) return value / rate; // 金额是报价币种、要换成基准 → 除
  throw new Error(`${from}→${to} 缺交叉汇率（基准是 ${baseCcy}），不猜`);
}
