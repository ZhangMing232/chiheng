/**
 * 龙虎榜净买（游资/营业部驱动）的「市场级防御信号」量化（overlay 版）。
 *
 * 单票回避过滤器只删「刚被机构爆买的票」。但这里问的是另一件事：
 * 如果某段时间全市场被净买（游资/营业部驱动）的票扎堆（净买压力高），是不是预示着随后大盘要被拖？
 * 因为被净买的票未来 10~20 天跑输，若一批票同时被净买，指数也会被这部分拖。
 *
 * 做法：
 *   1. 把所有龙虎榜事件按日汇总成「当日全市场净买（游资/营业部驱动）合计(万)」。
 *   2. 对沪深300每个交易日 k，算 trailing W(默认20) 交易日的净买压力 agg(k)。
 *   3. 按 agg 分低/高三组（丢掉中间 1/3 拉开差距），比未来 N=5/10/20 天沪深300收益。
 *   4. Welch t 检验 high 组是否显著差于 low 组。
 *   5. 模拟「high 日空仓 / low 日持有」的逐日再平衡累计收益，对比买入持有。
 *
 * 若 high 组未来收益显著更差、且模拟跑赢买入持有 → 这是个真防御信号，可接进实盘当总仓位 overlay
 * （高压力时降仓/转现金，长多可部署，不碰做空）。否则诚实说明集群信号不另加价值。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-lhb-overlay.ts
 */
import { readFile, readdir } from "node:fs/promises";

const RISK = "data/risk";
const WINDOW = Number(process.env.OVL_WIN ?? 20); // 拖拽窗口（交易日）
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

function welchT(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se === 0 ? 0 : (ma - mb) / se;
}

async function main() {
  console.log(`净买（游资/营业部驱动）防御 overlay 量化（拖拽窗口 ${WINDOW} 交易日）`);
  const net = await loadDailyNetBuy();
  const idx = await loadIndexReturns("sh000300");
  // 只用同时有净买记录和指数的交易日；按日期排序
  const dates = [...new Set([...net.keys(), ...idx.map((x) => x.date)])].sort();
  const closeByDate = new Map(idx.map((x) => [x.date, x.close]));

  // 每日净买（无则 0）
  const netArr = dates.map((d) => net.get(d) ?? 0);
  // 前缀和
  const P = new Array(dates.length + 1).fill(0);
  for (let i = 0; i < dates.length; i++) P[i + 1] = P[i] + netArr[i];
  // trailing W 净买压力
  const agg = dates.map((_, i) => P[i + 1] - (i - WINDOW >= 0 ? P[i - WINDOW + 1] : 0));

  // 日收益
  const ret = dates.map((d, i) => {
    const c = closeByDate.get(d);
    const pc = i > 0 ? closeByDate.get(dates[i - 1]) : undefined;
    return c != null && pc != null && pc > 0 ? c / pc - 1 : 0;
  });

  // 分组阈值（tertile，丢中间）
  const sorted = [...agg].filter((_, i) => i >= WINDOW && i + Math.max(...HOLD) < dates.length).sort((x, y) => x - y);
  const loTh = sorted[Math.floor(sorted.length / 3)];
  const hiTh = sorted[Math.floor((sorted.length * 2) / 3)];
  console.log(`净买压力 tertile 阈值：低 < ${Math.round(loTh)}万，高 > ${Math.round(hiTh)}万（万）`);

  console.log("\nN    低组收益   高组收益   差值       Welch t   低日数 高日数");
  console.log("-".repeat(72));
  const lowByN: Record<number, number[]> = {};
  const highByN: Record<number, number[]> = {};
  for (const N of HOLD) {
    lowByN[N] = [];
    highByN[N] = [];
  }
  const sim = { strat: 1, market: 1, days: 0, flatDays: 0 };
  for (let i = 0; i + Math.max(...HOLD) < dates.length; i++) {
    if (i < WINDOW) continue;
    for (const N of HOLD) {
      // 未来 N 日累计收益（用于 Welch t 分组检验）
      let fwd = 1;
      for (let j = 1; j <= N; j++) fwd *= 1 + ret[i + j];
      const r = fwd - 1;
      if (agg[i] <= loTh) lowByN[N].push(r);
      else if (agg[i] >= hiTh) highByN[N].push(r);
    }
    // 防御模拟：信号在 i，决定 i+1 这天持仓与否（单日近似，与 N 无关——只算一次）
    const pos = agg[i] >= hiTh ? 0 : ret[i + 1];
    sim.strat *= 1 + pos;
    sim.market *= 1 + ret[i + 1];
    sim.days++;
    if (agg[i] >= hiTh) sim.flatDays++;
  }
  for (const N of HOLD) {
    const low = lowByN[N];
    const high = highByN[N];
    const ml = low.reduce((s, x) => s + x, 0) / low.length;
    const mh = high.reduce((s, x) => s + x, 0) / high.length;
    const t = welchT(low, high);
    console.log(
      `${String(N).padEnd(4)}` +
        `${(ml * 100).toFixed(2)}%`.padStart(10) +
        `${(mh * 100).toFixed(2)}%`.padStart(10) +
        `${(ml * 100 - mh * 100).toFixed(2)}%`.padStart(9) +
        `${t >= 0 ? "+" : ""}${t.toFixed(2)}`.padStart(8) +
        `${String(low.length).padStart(7)}${String(high.length).padStart(7)}`,
    );
  }
  const stratRet = (sim.strat - 1) * 100;
  const mktRet = (sim.market - 1) * 100;
  console.log(
    `\n防御模拟（次日规则·理想化：高压力日次日空仓，其余满仓，零成本零滑点，阈值全程样本内）\n` +
      `  样本 ${sim.days} 天，其中空仓 ${sim.flatDays} 天（${((sim.flatDays / sim.days) * 100).toFixed(1)}%）\n` +
      `  防御累计：${stratRet >= 0 ? "+" : ""}${stratRet.toFixed(1)}%  vs 买入持有 ${mktRet >= 0 ? "+" : ""}${mktRet.toFixed(1)}%  （差值 ${stratRet - mktRet >= 0 ? "+" : ""}${(stratRet - mktRet).toFixed(1)}%）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
