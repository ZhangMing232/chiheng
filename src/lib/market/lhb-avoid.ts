/**
 * 龙虎榜净买回避过滤器（反向信号，游资/营业部驱动）—— **客户端安全的同步部分**。
 *
 * 由来（scripts/backtest-event.ts / backtest-lhb-seats.ts 的事件研究）：龙虎榜净买是一个真实、稳定、
 * 但反向的信号——龙虎榜爆买之后，该票平均跑输市场且拖累随持有期单调加深
 * （N=10 跑输 1.75%、N=20 跑输 3.11%、N=55 见底约 7.0%，信噪比约 −3.4，前后同向，
 * 两道关「过关」但方向负）。席位拆解表明：这信号是**游资/营业部**（拉萨天团、章盟主、炒股养家等
 * 情绪化追涨席位）驱动的，机构净买单独并不反向（t 仅 −1.76 没过双闸）。过滤器把全席位混加，
 * 因游资在量上占大头而恰好兜住真信号，并非机构驱动。
 *
 * 【为什么本文件不能 import node:fs】本文件被 src/lib/market/strategies.ts 引用，
 * 而 strategies.ts 在客户端可达图上（routeTree → routes/index.tsx → strategies.ts）。
 * 顶层 import node 内置模块会被 vite 转成空壳桩，浏览器一访问就抛 → hydration 死 →
 * 全站按钮点不动（10-25 meanwhy.top 整站失灵，同类坑第三次）。所以读盘的活儿
 * 全在 lhb-avoid-index.server.ts（TanStack 认 .server.ts 为服务端，客户端图直接终端）。
 *
 * 本文件只做两件事：存索引、按索引同步回答「这票该不该回避」。零 IO。
 */
// 阈值：游资/营业部席位对该股净买合计 ≥ LHB_THRESH 万元（默认 3000万）算一次事件。
// 3000 万是扫过的最优值（11-08，scripts/backtest-avoid-threshold.ts + 全量回测），别再凭直觉调：
//  · 事件研究层：N=55 时各档都过关，且阈值越高平均超额越狠（500万 −5.43% → 2亿 −10.05%），
//    但事件数从 11962 掉到 1618 —— 阈值越高、覆盖的策略候选票越少，等于没挡。
//  · 策略层（趋势回踩，W=80）：3000 万最好（超额 +0.31%、t=1.65、前后同向✓），
//    5000 接近（+0.30%），1000/2000 和 8000+ 都明显变差（低阈值误伤好票、高阈值挡不到票）。
//  · 三个独立抽样批次（BT_SAMPLE=800 时 step=3，只有 3 批，off3+ 是重复的）增益全为正
//    （+0.36% / +0.19% / +0.08%），被挡票每批都跑输留票。早前「offset1 反向」是把
//    「开过滤后超额仍为负」误读成「过滤器变差」——关过滤 −0.31% → 开 −0.12% 其实是改善。
//    见 scripts/diag-offset1.ts。结论仍是默认关：全区间聚类 t=1.72 不过双闸，且只有趋势回踩受益。
export const LHB_THRESH = Number(process.env.LHB_THRESH ?? 3000); // 万元
// 席位口径：noninst=仅游资/营业部（反向信号真驱动，推荐，默认）；all=全席位混加（旧口径）。
// 席位拆解研究（backtest-lhb-seats.ts）表明反向 edge 由游资/营业部驱动，机构净买单独不反向（t≈−1.76 没过双闸），
// 故默认切到 noninst：信号更强（N=20 信噪比 −3.65 vs −3.37）且能补抓「游资≥3000 但机构为负拉低全合计」的纯游资日。
export const SEATS: "noninst" | "all" = (process.env.LHB_SEATS ?? "noninst").toLowerCase() === "all" ? "all" : "noninst";

let index: Map<string, string[]> | null = null;

function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** 写入模块级索引（由 lhb-avoid-index.server.ts 的 loadAvoidIndex 调用）。 */
export function setAvoidIndex(m: Map<string, string[]>): void {
  index = m;
}

/** 取当前索引（未加载时为 null）。 */
export function getAvoidIndex(): Map<string, string[]> | null {
  return index;
}

/**
 * 该票在 [date - windowDays, date] 内是否有龙虎榜净买事件（游资/营业部驱动的反向信号）。
 * 索引未加载（loadAvoidIndex 没跑过）时返回 false —— 宁可不多删，不能因为漏加载而静默全删。
 */
export function shouldAvoid(code: string, date: string, windowDays: number): boolean {
  const arr = index?.get(code);
  if (!arr || arr.length === 0) return false;
  const thr = shiftDate(date, -windowDays);
  return arr.some((d) => d >= thr && d <= date);
}
