/**
 * 方向 D：指数择时多空。把 bullishAt（指数 > 20MA）当策略核心，而非单票回测的闸口。
 *
 * 为什么单独一个脚本而不是塞进 backtest.ts 的 STRATEGIES 表：
 * 那张表是「逐票选股」循环，单位是单只股票；指数择时是单标的、按天决策，
 * 硬塞进去要绕很多弯。这里直接拿指数日线跑，干净。
 *
 * 取数口径和 scripts/backtest.ts:215 的 fetchKline 完全一致（指数无复权，走 day 接口），
 * 别自己换一套，否则和单票回测的窗口对不上。
 *
 * 判定用白皮书 §4 两道关：聚类 |t|≥2 且 前后同向，直接复用 genome-verdict。
 * bench 取「始终持有（买入持有指数）」——我们要回答的是「择时有没有比躺着不动强」。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-index.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
const KLINE_HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" };
const LOOKBACK = 250;
// ETF 来回成本估算，保守取 0.1%（真实比这低，先从严）。每天在市就扣一次。
const INDEX_COST = 0.001;

async function fetchKline(id: string): Promise<Row[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,${LOOKBACK + 80}`;
  const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const out: Row[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const o = Number(r[1]);
    const c = Number(r[2]);
    const h = Number(r[3]);
    const l = Number(r[4]);
    const v = Number(r[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    out.push({ date: r[0], o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

function ma(arr: number[], i: number, w: number): number {
  const s = arr.slice(Math.max(0, i - w + 1), i + 1);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function run(rows: Row[], label: string): void {
  const closes = rows.map((r) => r.c);
  const dates = rows.map((r) => r.date);
  const n = closes.length;
  const ma20 = closes.map((_, i) => ma(closes, i, 20));
  // 第 i 天收盘决策：指数站在 20MA 上方 = 看多
  const bullish = closes.map((c, i) => i >= 20 && c > ma20[i]);
  // idxRet[i] = 用第 i-1 天收盘决策、持有过夜赚到的第 i 天日收益
  const idxRet: number[] = [];
  for (let i = 1; i < n; i += 1) idxRet.push(closes[i] / closes[i - 1] - 1);

  // 基准：买入持有指数（每天扣成本）
  const bench: number[] = idxRet.map((r) => r - INDEX_COST);

  const strats: { name: string; ret: number[] }[] = [];
  strats.push({ name: "始终持有(买持)", ret: bench.slice() });
  strats.push({
    name: "看多持多/否则空仓",
    ret: idxRet.map((r, i) => (bullish[i] ? r - INDEX_COST : 0)),
  });
  strats.push({
    name: "看多持多/看空持空",
    ret: idxRet.map((r, i) => (bullish[i] ? r - INDEX_COST : -r - INDEX_COST)),
  });

  console.log(`\n=== ${label} ===`);
  console.log(`窗口 ${dates[1] ?? dates[0]} ~ ${dates[n - 1]}  共 ${idxRet.length} 个交易日`);
  console.log("策略              总收益    年化    信噪比   前后半段   两道关判定");
  console.log("-".repeat(80));
  for (const s of strats) {
    let eq = 1;
    for (const r of s.ret) eq *= 1 + r;
    const total = eq - 1;
    const years = idxRet.length / 244;
    const ann = Math.pow(eq, 1 / years) - 1;
    const trades = s.ret.map((r, i) => ({ ret: r, bench: bench[i], exitDate: dates[i + 1] ?? dates[i] }));
    const cg = clusterTOf(trades);
    const hs = halvesSameSignOf(trades);
    const v = judgeGenomeVerdict({
      ran: true,
      trades: trades.length,
      excessPp: cg ? cg.excess * 100 : null,
      clusteredT: cg ? cg.clusterT : null,
      halvesSameSign: hs,
    });
    const tStr = cg && cg.clusterT != null ? (cg.clusterT >= 0 ? "+" : "") + cg.clusterT.toFixed(2) : "算不出";
    const hsStr = hs == null ? "?" : hs ? "同向✓" : "翻脸✗";
    const verdict = v.status === "promoted" ? "过关 ✓" : v.status === "rejected" ? "没过 ✗" : "样本不足";
    console.log(
      s.name.padEnd(18) +
        `${(total * 100).toFixed(1)}%`.padStart(8) +
        `${(ann * 100).toFixed(1)}%`.padStart(9) +
        tStr.padStart(8) +
        hsStr.padStart(8) +
        verdict.padStart(10),
    );
  }
}

async function main() {
  console.log("指数择时多空回测（成本估算 ETF 来回 0.1%/天在市）");
  for (const [id, label] of [
    ["sh000300", "沪深300"],
    ["sz399905", "中证500"],
  ] as [string, string][]) {
    const rows = await fetchKline(id);
    run(rows, label);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
