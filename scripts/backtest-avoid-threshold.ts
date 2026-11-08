/**
 * 净买阈值 LHB_THRESH 扫描（#3）。
 *
 * 问的是：**3000 万是不是最优？** 阈值决定「多大一笔游资爆买才算反向信号」。
 * 太低 → 噪音事件一大堆、误挡面变大；太高 → 只剩少数极端票、样本不够判决。
 *
 * 【口径与 live 完全一致】
 *   - 席位：NONINST（剔除"机构"席位，只聚合游资/营业部），与 LHB_SEATS 默认一致
 *   - 事件：某日该票游资/营业部净买合计 ≥ THRESH 万元
 *   - 买入：事件日次日开盘价（t+1 open）——龙虎榜是收盘后才披露的，最早次日开盘能买
 *   - 卖出：t+N 收盘价；个股收益 = exit/entry - 1 - COST(0.3% 来回)
 *   - 超额 = 个股收益 - 沪深300 同期收益
 *   - 判决：clusterTOf（按平仓日聚类的稳健 t）+ halvesSameSignOf + judgeGenomeVerdict
 *
 * 【为什么看 N=20 和 N=55 两个 horizon】
 *   拖累曲线（scripts/backtest-avoid-window.ts）显示 N=55 才饱和（−7.0%）；
 *   N=20 是老口径。W=80 自然日 ≈ 55 交易日，所以 N=55 更贴近实际部署。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-avoid-threshold.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { readFile, readdir } from "node:fs/promises";
import { codePrefix } from "@/lib/market/code-prefix";

const CACHE = "data/backtest/kline";
const RISK = "data/risk";
const COST = 0.003;
const HOLD_DAYS = [10, 20, 55];
const THRESHOLDS = [500, 1000, 2000, 3000, 5000, 8000, 12000, 20000];

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
type Trade = { ret: number; bench: number; exitDate: string };



async function loadKline(code: string): Promise<Row[]> {
  try {
    const p = await readFile(CACHE + "/" + code + ".json", "utf8");
    const rows = JSON.parse(p) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function loadIndex(id: string): Promise<Map<string, number>> {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + id + ",day,,,400";
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("指数取数失败 " + res.status);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const m = new Map<string, number>();
  for (const r of rows) if (Array.isArray(r) && r.length >= 3) m.set(r[0], Number(r[2]));
  return m;
}

/** 一次读盘：逐票逐日聚合 NONINST 净买（万），返回 Map<"code|date", number>。 */
async function buildAgg(): Promise<Map<string, number>> {
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(RISK + "/hotmoney-names.json", "utf8"));
  } catch {
    console.log("（没有 hotmoney-names.json，无法映射代码）");
    return new Map();
  }
  const files = (await readdir(RISK + "/hotmoney")).filter((f) => f.endsWith(".json")).sort();
  const m = new Map<string, number>();
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(await readFile(RISK + "/hotmoney/" + f, "utf8"));
    } catch {
      continue;
    }
    if (!d.date) continue;
    const agg: Record<string, number> = {};
    for (const seat of d.seats ?? []) {
      if (seat.name === "机构") continue; // NONINST：剔除机构席位
      for (const st of seat.stocks ?? []) {
        const code = codePrefix(names[st.name]);
        if (!code) continue;
        agg[code] = (agg[code] ?? 0) + (Number(st.netWan) || 0);
      }
    }
    for (const [code, net] of Object.entries(agg)) {
      if (net > 0) m.set(code + "|" + d.date, net);
    }
  }
  return m;
}

const pct2 = (x: number) => (x * 100).toFixed(2) + "%";
const fix = (x: number | null, d: number) => (x == null ? "算不出" : x.toFixed(d));
const pad = (s: string, n: number) => s.padStart(n);

async function main() {
  console.log("净买阈值扫描（NONINST 口径；t+1 开盘买 → t+N 收盘卖；成本 0.3%；基准沪深300）");
  const bench = await loadIndex("sh000300");
  const agg = await buildAgg();
  console.log("净买记录 " + agg.size + " 票·日，可用基准交易日 " + bench.size);

  // 预读所有涉及票的 K 线，避免每个阈值重复读盘
  const codes = [...new Set([...agg.keys()].map((k) => k.split("|")[0]))];
  const kl = new Map<string, Row[]>();
  for (const c of codes) kl.set(c, await loadKline(c));
  console.log("预读 K 线 " + kl.size + " 只（有数据的 " + [...kl.values()].filter((k) => k.length > 0).length + " 只）");

  for (const N of HOLD_DAYS) {
    console.log("");
    console.log("=== 持有 N=" + N + " 交易日 ===");
    console.log(pad("阈值(万)", 10) + pad("事件", 8) + pad("笔数", 8) + pad("平均超额", 11) + pad("聚类t", 9) + pad("前后", 9) + pad("判定", 10));
    console.log("-".repeat(65));
    for (const TH of THRESHOLDS) {
      const evs: { code: string; date: string }[] = [];
      for (const [k, net] of agg) {
        if (net >= TH) {
          const [code, date] = k.split("|");
          evs.push({ code, date });
        }
      }
      const trades: Trade[] = [];
      for (const ev of evs) {
        const k = kl.get(ev.code);
        if (!k || k.length < N + 2) continue;
        const idx = k.findIndex((r) => r.date === ev.date);
        if (idx < 0 || idx + N >= k.length) continue;
        const entry = k[idx + 1].o;
        const exit = k[idx + N].c;
        if (!(entry > 0) || !(exit > 0)) continue;
        const bi = bench.get(ev.date);
        const be = bench.get(k[idx + N].date);
        if (bi == null || be == null || !(bi > 0)) continue;
        trades.push({ ret: exit / entry - 1 - COST, bench: be / bi - 1, exitDate: k[idx + N].date });
      }
      if (trades.length < 30) {
        console.log(pad(String(TH), 10) + pad(String(evs.length), 8) + pad(String(trades.length), 8) + "  样本不足（<30 笔）");
        continue;
      }
      const cg = clusterTOf(trades);
      const hs = halvesSameSignOf(trades);
      const v = judgeGenomeVerdict({
        ran: true,
        trades: trades.length,
        excessPp: cg ? cg.excess * 100 : null,
        clusteredT: cg ? cg.clusterT : null,
        halvesSameSign: hs,
      });
      const verdict = v.status === "promoted" ? "过关 ✓" : v.status === "rejected" ? "没过 ✗" : "样本不足";
      const sign = cg && cg.excess < 0 ? "（反向）" : "";
      console.log(
        pad(String(TH), 10) +
          pad(String(evs.length), 8) +
          pad(String(trades.length), 8) +
          pad(pct2(cg ? cg.excess : 0), 11) +
          pad(fix(cg ? cg.clusterT : null, 2), 9) +
          pad(hs == null ? "?" : hs ? "同向✓" : "翻脸✗", 9) +
          pad(verdict + sign, 10),
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
