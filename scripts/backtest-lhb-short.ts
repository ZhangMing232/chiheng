/**
 * 龙虎榜净买（游资/营业部驱动）「反向信号」的做空量化。
 *
 * 来源：backtest-event.ts 证实——机构大举净买后 10~20 天该票平均跑输 1.5~2.9%
 * （信噪比 −2.88~−3.37，前后同向，两道关「过」但方向负）。长多没法用（买它亏），
 * 但反过来做空就是正 edge。本脚本把这个信号当「做空策略」认真量一遍：到底多能赚、稳不稳。
 *
 * 做法（模拟做空，不碰实盘）：
 *   事件日 t（龙虎榜净买（游资/营业部驱动） ≥ 阈值）→ t+1 开盘卖空 → 持有 N 个交易日 → t+N 收盘回补。
 *   每笔做空收益 = −(t+N收盘 / t+1开盘 − 1) − 成本。
 *   每笔超额 = 做空收益 − 同期沪深300收益。
 *   信噪比 + 前后同向，过白皮书两道关才算「可作为做空策略站住」。
 *
 * 模拟假设（非实盘）：无限券源、t+1 可开可平、忽略涨跌停无法回补、成本 0.3% 来回。
 * 实盘 A 股做空受券源/保证金/涨跌停限制，本脚本只量化信号本身大小，不代表可直接实盘。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-lhb-short.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { readFile, readdir } from "node:fs/promises";
import { codePrefix } from "@/lib/market/code-prefix";

const CACHE = "data/backtest/kline";
const RISK = "data/risk";
const COST = 0.003; // 一来一回 0.3%（股票双边费 + 滑点粗估）
const HOLD_DAYS = [5, 10, 20];
const HM_THRESH = Number(process.env.HM_THRESH ?? 3000); // 万元

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
type Event = { code: string; date: string; mag: number };

// 风险数据里的代码是无前缀的 6 位（"601318"），但 kline 缓存文件名带前缀（"sh601318.json"）。


async function loadKline(code: string): Promise<Row[]> {
  try {
    const p = await readFile(`${CACHE}/${code}.json`, "utf8");
    const rows = JSON.parse(p) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function loadIndex(name: string, id: string): Promise<Map<string, number>> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,400`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${name} 指数取数失败 ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const m = new Map<string, number>();
  for (const r of rows) if (Array.isArray(r) && r.length >= 3) m.set(r[0], Number(r[2]));
  return m;
}

// 只取龙虎榜净买（游资/营业部驱动）事件（两融在事件研究里没信号，不纳入）。口径与 backtest-event.ts 完全一致。
async function buildEvents(): Promise<Event[]> {
  const events: Event[] = [];
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(`${RISK}/hotmoney-names.json`, "utf8"));
  } catch {
    console.log("（没有 hotmoney-names.json，龙虎榜事件无法映射代码，退出）");
    return events;
  }
  const files = (await readdir(`${RISK}/hotmoney`)).filter((f) => f.endsWith(".json")).map((f) => `${RISK}/hotmoney/${f}`).sort();
  let skippedName = 0;
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(await readFile(f, "utf8"));
    } catch {
      continue;
    }
    const date: string = d.date;
    if (!date) continue;
    const agg: Record<string, number> = {};
    for (const seat of d.seats ?? []) {
      for (const st of seat.stocks ?? []) {
        const code = names[st.name];
        if (!code) {
          skippedName += 1;
          continue;
        }
        const pcode = codePrefix(code);
        agg[pcode] = (agg[pcode] ?? 0) + (Number(st.netWan) || 0);
      }
    }
    for (const [code, net] of Object.entries(agg)) {
      if (net >= HM_THRESH) events.push({ code, date, mag: net });
    }
  }
  console.log(`龙虎榜净买（游资/营业部驱动）事件总数 ${events.length}（阈值 ${HM_THRESH}万；未映射名称 ${skippedName} 次）`);
  return events;
}

async function evaluate(events: Event[], index: Map<string, number>) {
  if (events.length === 0) {
    console.log("（无事件）");
    return;
  }
  const codes = [...new Set(events.map((e) => e.code))];
  const klines = new Map<string, Row[]>();
  for (const code of codes) klines.set(code, await loadKline(code));

  console.log("\n持有   笔数    平均做空收益  胜率    信噪比   前后半段   两道关判定       最惨单笔");
  console.log("-".repeat(92));
  for (const N of HOLD_DAYS) {
    const trades: { ret: number; bench: number; exitDate: string }[] = [];
    let skipped = 0;
    for (const ev of events) {
      const k = klines.get(ev.code);
      if (!k || k.length < N + 2) {
        skipped += 1;
        continue;
      }
      const idx = k.findIndex((r) => r.date === ev.date);
      if (idx < 0 || idx + N >= k.length) {
        skipped += 1;
        continue;
      }
      const entry = k[idx + 1].o; // t+1 开盘卖空
      const exit = k[idx + N].c; // t+N 收盘回补
      if (!(entry > 0)) {
        skipped += 1;
        continue;
      }
      const bi = index.get(ev.date);
      const be = index.get(k[idx + N].date);
      if (bi == null || be == null || !(bi > 0)) {
        skipped += 1;
        continue;
      }
      const stockRet = exit / entry - 1; // 个股区间收益
      const bench = be / bi - 1; // 沪深300区间收益
      // 市场中性做空：卖空个股 + 做多基准。edge = 基准 − 个股 − 成本，
      // 去掉市场 beta，只留「该股跑输大盘」这块 alpha（也是原事件研究负的那块取反）。
      const shortPnL = bench - stockRet - COST;
      trades.push({ ret: shortPnL, bench: 0, exitDate: k[idx + N].date });
    }
    if (trades.length < 8) {
      console.log(`${String(N).padEnd(4)} ${trades.length.toString().padStart(6)}  样本不足（可用 ${trades.length}，跳过 ${skipped}）`);
      continue;
    }
    // 用算术均值（不是几何复利）：做空遇涨停连板会爆仓，几何累计会被少数极端笔带成 -100%，没意义。
    const meanPnL = trades.reduce((a, t) => a + t.ret, 0) / trades.length;
    const worst = Math.min(...trades.map((t) => t.ret));
    const win = trades.filter((t) => t.ret > 0).length / trades.length;
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
      `${String(N).padEnd(4)}` +
        `${trades.length.toString().padStart(6)}` +
        `${(meanPnL * 100).toFixed(2)}%`.padStart(10) +
        `${(win * 100).toFixed(1)}%`.padStart(7) +
        tStr.padStart(8) +
        hsStr.padStart(8) +
        verdict.padStart(10) +
        `   最惨单笔 ${(worst * 100).toFixed(0)}%`,
    );
  }
}

async function main() {
  console.log(`龙虎榜反向做空量化（模拟；成本估算 0.3%/来回；龙虎榜阈值 ${HM_THRESH}万）`);
  const index = await loadIndex("沪深300", "sh000300");
  const events = await buildEvents();
  await evaluate(events, index);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
