/**
 * 龙虎榜净买（游资/营业部驱动）「市场级防御 overlay」—— walk-forward 验证版。
 *
 * 与 backtest-lhb-overlay.ts 的区别（也是做这个脚本的原因）：
 *   旧版阈值 loTh/hiTh 是「全程样本内」拟合的 tertile，等于拿未来数据定规则 → 过拟合上界。
 *   本版改成滚动分位：在第 i 天，用「截止到 i 的过去 LOOKBACK 天 agg」算第 PCT 分位当触发线，
 *   只依赖历史，不偷看未来。这才是样本外（out-of-sample）信号检验。
 *
 * 同时改进：
 *   1. 信号检验用滚动分位分类后的「未来 N 日收益」重新算 Welch t（样本外）。
 *   2. 防御模拟改成梯度仓位（高压力日总多头 LONG_HIGH，中性日 LONG_LOW），不再是二元满仓/空仓；
 *      每次仓位切换按「变动暴露 × COST」扣交易成本+滑点，给出真实拖拽。
 *
 * 诚实判据：
 *   - 样本外 Welch t 仍显著（high 组未来收益显著差于 low 组）→ 信号真；否则只是样本内幻觉。
 *   - 扣成本后防御累计仍跑赢买入持有 → 实盘值得接；否则边缘被成本吃掉，不接。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-lhb-overlay-wf.ts
 * 可调：OVL_WIN(20) OVL_LOOKBACK(250) OVL_PCT(66) OVL_LONG_HIGH(0.5) OVL_LONG_LOW(1.0) OVL_COST(0.001)
 */
import { readFile, readdir } from "node:fs/promises";

const RISK = "data/risk";
const WINDOW = Number(process.env.OVL_WIN ?? 20); // 净买压力拖拽窗口（交易日）
const LOOKBACK = Number(process.env.OVL_LOOKBACK ?? 250); // 滚动分位回看窗口
const PCT = Number(process.env.OVL_PCT ?? 66); // 触发分位（顶部 1/3 = 高压力）
const LONG_HIGH = Number(process.env.OVL_LONG_HIGH ?? 0.5); // 高压力日总多头仓位
const LONG_LOW = Number(process.env.OVL_LONG_LOW ?? 1.0); // 中性日总多头仓位
const COST = Number(process.env.OVL_COST ?? 0.001); // 每次切换的「变动暴露 × COST」成本
const HOLD = [5, 10, 20];

async function loadDailyNetBuy(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const files = (await readdir(`${RISK}/hotmoney`)).filter((f) => f.endsWith(".json")).map((f) => `${RISK}/hotmoney/${f}`).sort();
  let total = 0;
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(await readFile(f, "utf8"));
    } catch {
      continue;
    }
    const date: string = d.date;
    if (!date) continue;
    let dayNet = 0;
    for (const seat of d.seats ?? []) {
      for (const st of seat.stocks ?? []) {
        dayNet += Number(st.netWan) || 0;
      }
    }
    m.set(date, (m.get(date) ?? 0) + dayNet);
    total += dayNet;
  }
  console.log(`龙虎榜净买事件日 ${m.size} 天，全市场净买合计 ${Math.round(total)} 万`);
  return m;
}

async function loadIndexReturns(id: string): Promise<{ date: string; close: number }[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,800`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`指数取数失败 ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const out: { date: string; close: number }[] = [];
  for (const r of rows) if (Array.isArray(r) && r.length >= 3) out.push({ date: r[0], close: Number(r[2]) });
  return out;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Infinity;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}

function welchT(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se === 0 ? 0 : (ma - mb) / se;
}

async function main() {
  console.log(`净买（游资/营业部驱动）防御 overlay · walk-forward（压力窗 ${WINDOW} / 回看 ${LOOKBACK} / 分位 ${PCT} / 高压力仓位 ${LONG_HIGH} / 中性仓位 ${LONG_LOW} / 切换成本 ${COST}）`);
  const net = await loadDailyNetBuy();
  const idx = await loadIndexReturns("sh000300");
  const dates = [...new Set([...net.keys(), ...idx.map((x) => x.date)])].sort();
  const closeByDate = new Map(idx.map((x) => [x.date, x.close]));

  const netArr = dates.map((d) => net.get(d) ?? 0);
  const P = new Array(dates.length + 1).fill(0);
  for (let i = 0; i < dates.length; i++) P[i + 1] = P[i] + netArr[i];
  const agg = dates.map((_, i) => P[i + 1] - (i - WINDOW >= 0 ? P[i - WINDOW + 1] : 0));

  const ret = dates.map((d, i) => {
    const c = closeByDate.get(d);
    const pc = i > 0 ? closeByDate.get(dates[i - 1]) : undefined;
    return c != null && pc != null && pc > 0 ? c / pc - 1 : 0;
  });

  // ---------- 基线：全程样本内 tertile（旧版，用作对照，看过拟合上界）----------
  const valid = (i: number) => i >= WINDOW && i + Math.max(...HOLD) < dates.length;
  const sortedAll = [...agg].filter((_, i) => valid(i)).sort((a, b) => a - b);
  const loTh = sortedAll[Math.floor(sortedAll.length / 3)];
  const hiTh = sortedAll[Math.floor((sortedAll.length * 2) / 3)];
  const insLow: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  const insHigh: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  for (let i = 0; i < dates.length; i++) {
    if (!valid(i)) continue;
    for (const N of HOLD) {
      let fwd = 1;
      for (let j = 1; j <= N; j++) fwd *= 1 + ret[i + j];
      const r = fwd - 1;
      if (agg[i] <= loTh) insLow[N].push(r);
      else if (agg[i] >= hiTh) insHigh[N].push(r);
    }
  }

  // ---------- walk-forward：滚动分位分类（样本外）----------
  const wfLow: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  const wfHigh: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  let strat = 1;
  let market = 1;
  let prevPos = LONG_LOW;
  let switches = 0;
  let costDrag = 0;
  let highDays = 0;
  let simDays = 0;
  for (let i = 0; i < dates.length; i++) {
    if (!valid(i) || i < LOOKBACK) continue;
    const win = [...agg.slice(i - LOOKBACK + 1, i + 1)].sort((a, b) => a - b);
    const thr = percentile(win, PCT);
    const high = agg[i] >= thr;
    // 收集样本外信号分类下的未来 N 日收益
    for (const N of HOLD) {
      let fwd = 1;
      for (let j = 1; j <= N; j++) fwd *= 1 + ret[i + j];
      const r = fwd - 1;
      if (!high) wfLow[N].push(r);
      else wfHigh[N].push(r);
    }
    // 梯度仓位防御模拟：第 i 天的信号决定第 i+1 天的仓位
    if (i + 1 < dates.length) {
      const target = high ? LONG_HIGH : LONG_LOW;
      let r = target * ret[i + 1];
      if (target !== prevPos) {
        const c = Math.abs(target - prevPos) * COST;
        r -= c;
        costDrag += c;
        switches++;
      }
      strat *= 1 + r;
      market *= 1 + ret[i + 1];
      prevPos = target;
      simDays++;
      if (high) highDays++;
    }
  }

  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  console.log("\n=== 信号检验：high 组 vs low 组 未来收益（Welch t）===");
  console.log("N    低组      高组      差值      样本内t   样本外t   低n   高n");
  console.log("-".repeat(74));
  for (const N of HOLD) {
    const ml = insLow[N].reduce((s, x) => s + x, 0) / insLow[N].length;
    const mh = insHigh[N].reduce((s, x) => s + x, 0) / insHigh[N].length;
    const tIn = welchT(insLow[N], insHigh[N]);
    const tWf = welchT(wfLow[N], wfHigh[N]);
    console.log(
      `${String(N).padEnd(4)}` +
        `${pct(ml).padStart(9)}` +
        `${pct(mh).padStart(9)}` +
        `${pct(ml - mh).padStart(9)}` +
        `${tIn >= 0 ? "+" : ""}${tIn.toFixed(2)}`.padStart(9) +
        `${tWf >= 0 ? "+" : ""}${tWf.toFixed(2)}`.padStart(9) +
        `${String(wfLow[N].length).padStart(6)}${String(wfHigh[N].length).padStart(6)}`,
    );
  }

  const stratRet = strat - 1;
  const mktRet = market - 1;
  console.log("\n=== 梯度仓位防御模拟（样本外，含交易成本滑点）===");
  console.log(`  模拟天数 ${simDays}，其中高压力日 ${highDays}（${(highDays / simDays * 100).toFixed(1)}%），切换 ${switches} 次`);
  console.log(`  累计交易成本拖拽：${pct(-costDrag)}`);
  console.log(`  防御累计：${pct(stratRet)}  vs 买入持有 ${pct(mktRet)}  （差值 ${pct(stratRet - mktRet)}）`);
  console.log(`  注：仓位 ${LONG_LOW}↔${LONG_HIGH}，每次切换扣 |Δ仓位|×${COST}；基线样本内理想化为对照，非可部署估计。`);

  // ---------- 时序切分：前半段定「绝对阈值」，后半段纯样本外 ----------
  // 滚动分位失败的根因 = 净买压力在样本内趋势上行，相对分位被趋势污染。
  // 原 in-sample 发现是「绝对极端」（>171.93亿/日），与趋势无关。这里用前半段定绝对触发线，盲测后半段。
  const validIdx: number[] = [];
  for (let i = 0; i < dates.length; i++) if (valid(i)) validIdx.push(i);
  const cut = Math.floor(validIdx.length / 2);
  const calibAgg = validIdx.slice(0, cut).map((i) => agg[i]).sort((a, b) => a - b);
  const absHi = percentile(calibAgg, PCT);
  const oosLow: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  const oosHigh: Record<number, number[]> = { 5: [], 10: [], 20: [] };
  let oStrat = 1;
  let oMarket = 1;
  let oPrev = LONG_LOW;
  let oSw = 0;
  let oCost = 0;
  let oHigh = 0;
  let oDays = 0;
  for (let k = cut; k < validIdx.length; k++) {
    const i = validIdx[k];
    const high = agg[i] >= absHi;
    for (const N of HOLD) {
      let fwd = 1;
      for (let j = 1; j <= N; j++) fwd *= 1 + ret[i + j];
      const r = fwd - 1;
      if (!high) oosLow[N].push(r);
      else oosHigh[N].push(r);
    }
    if (i + 1 < dates.length) {
      const target = high ? LONG_HIGH : LONG_LOW;
      let r = target * ret[i + 1];
      if (target !== oPrev) {
        const c = Math.abs(target - oPrev) * COST;
        r -= c;
        oCost += c;
        oSw++;
      }
      oStrat *= 1 + r;
      oMarket *= 1 + ret[i + 1];
      oPrev = target;
      oDays++;
      if (high) oHigh++;
    }
  }
  console.log(`\n=== 时序切分：前半段定绝对阈值 ${Math.round(absHi)}万，盲测后半段（纯样本外）===`);
  console.log("N    低组      高组      差值      样本外t   低n   高n");
  console.log("-".repeat(58));
  for (const N of HOLD) {
    const ml = oosLow[N].reduce((s, x) => s + x, 0) / oosLow[N].length;
    const mh = oosHigh[N].reduce((s, x) => s + x, 0) / oosHigh[N].length;
    const t = welchT(oosLow[N], oosHigh[N]);
    console.log(
      `${String(N).padEnd(4)}` +
        `${pct(ml).padStart(9)}` +
        `${pct(mh).padStart(9)}` +
        `${pct(ml - mh).padStart(9)}` +
        `${t >= 0 ? "+" : ""}${t.toFixed(2)}`.padStart(9) +
        `${String(oosLow[N].length).padStart(6)}${String(oosHigh[N].length).padStart(6)}`,
    );
  }
  console.log(`  模拟天数 ${oDays}，高压力日 ${oHigh}（${(oHigh / oDays * 100).toFixed(1)}%），切换 ${oSw} 次，成本拖拽 ${pct(-oCost)}`);
  console.log(`  防御累计：${pct(oStrat - 1)}  vs 买入持有 ${pct(oMarket - 1)}  （差值 ${pct(oStrat - oMarket)}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
