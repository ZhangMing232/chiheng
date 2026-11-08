/**
 * 龙虎榜反向 edge 按「席位类型」拆解。
 *
 * 背景：现有回避过滤器与当初验证用的 backtest-event.ts，都是把「所有席位」净买混加
 * （机构 + 拉萨天团 + 章盟主 + 炒股养家 + 温州帮 + …），注释写"机构净买"但实际没区分。
 * 这个 edge 到底是不是机构专用、有没有被游资/营业部稀释或污染，从没验过。
 *
 * 本脚本把净买按席位拆成三类事件，分别跑同一套双闸事件研究（t+1 开盘买、t+N 收盘卖、
 * 超额=个股−沪深300−成本，clusterTOf + 前后同向 + 两道关），直接比：
 *   - ALL   : 全席位净买合计 ≥ 3000万（= 现有过滤器口径，作基线）
 *   - INST  : 仅"机构"席位净买 ≥ 3000万
 *   - NONINST: 仅游资/营业部席位净买 ≥ 3000万
 * 反向信号 = 超额显著为负（机构买完后跑输）。谁负的更狠、信噪比更高、两道关更稳，谁就是真驱动。
 *
 * 额外给一个部署决策量：现有 ALL 事件里，多少是机构驱动（inst≥3000）、多少是纯游资驱动
 * （inst<3000 但游资≥3000）——后者若是噪音，改成 INST-only 能大幅少误杀。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-lhb-seats.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { readFile, readdir } from "node:fs/promises";
import { codePrefix } from "@/lib/market/code-prefix";

const CACHE = "data/backtest/kline";
const RISK = "data/risk";
const COST = 0.003;
const HOLD_DAYS = [5, 10, 20];
const HM_THRESH = Number(process.env.HM_THRESH ?? 3000);

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
type Cat = "ALL" | "INST" | "NONINST";
type AggRec = { inst: number; noninst: number; all: number };



async function loadKline(code: string): Promise<Row[]> {
  try {
    const p = await readFile(`${CACHE}/${code}.json`, "utf8");
    const rows = JSON.parse(p) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function loadIndex(id: string): Promise<Map<string, number>> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,400`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`指数取数失败 ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  const m = new Map<string, number>();
  for (const r of rows) if (Array.isArray(r) && r.length >= 3) m.set(r[0], Number(r[2]));
  return m;
}

/** 逐票逐日聚合 inst / noninst / all 净买（万），返回 Map<code|date, AggRec>。 */
async function buildAgg(): Promise<Map<string, AggRec>> {
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(`${RISK}/hotmoney-names.json`, "utf8"));
  } catch {
    console.log("（没有 hotmoney-names.json，无法映射代码）");
  }
  const files = (await readdir(`${RISK}/hotmoney`)).filter((f) => f.endsWith(".json")).map((f) => `${RISK}/hotmoney/${f}`).sort();
  const m = new Map<string, AggRec>();
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(await readFile(f, "utf8"));
    } catch {
      continue;
    }
    const date: string = d.date;
    if (!date) continue;
    for (const seat of d.seats ?? []) {
      const isInst = seat.name === "机构";
      for (const st of seat.stocks ?? []) {
        const code = names[st.name];
        if (!code) continue;
        const pcode = codePrefix(code);
        const w = Number(st.netWan) || 0;
        const key = `${pcode}|${date}`;
        const rec = m.get(key) ?? { inst: 0, noninst: 0, all: 0 };
        rec.all += w;
        if (isInst) rec.inst += w;
        else rec.noninst += w;
        m.set(key, rec);
      }
    }
  }
  return m;
}

type Ev = { code: string; date: string };

function eventsFor(agg: Map<string, AggRec>, cat: Cat): Ev[] {
  const out: Ev[] = [];
  for (const [key, rec] of agg) {
    const net = cat === "INST" ? rec.inst : cat === "NONINST" ? rec.noninst : rec.all;
    if (net >= HM_THRESH) {
      const [code, date] = key.split("|");
      out.push({ code, date });
    }
  }
  return out;
}

async function evaluate(cat: Cat, events: Ev[], index: Map<string, number>) {
  console.log(`\n=== ${cat}（事件 ${events.length}，阈值 ${HM_THRESH}万）===`);
  console.log("持有   笔数    总收益   平均超额  信噪比   前后半段   两道关判定");
  console.log("-".repeat(72));
  if (events.length === 0) {
    console.log("（无事件）");
    return;
  }
  const codes = [...new Set(events.map((e) => e.code))];
  const klines = new Map<string, Row[]>();
  for (const code of codes) klines.set(code, await loadKline(code));

  for (const N of HOLD_DAYS) {
    const trades: { ret: number; bench: number; exitDate: string }[] = [];
    let skipped = 0;
    for (const ev of events) {
      const k = klines.get(ev.code);
      if (!k || k.length < N + 2) { skipped++; continue; }
      const idx = k.findIndex((r) => r.date === ev.date);
      if (idx < 0 || idx + N >= k.length) { skipped++; continue; }
      const entry = k[idx + 1].o;
      const exit = k[idx + N].c;
      if (!(entry > 0)) { skipped++; continue; }
      const ret = exit / entry - 1 - COST;
      const bi = index.get(ev.date);
      const be = index.get(k[idx + N].date);
      if (bi == null || be == null || !(bi > 0)) { skipped++; continue; }
      const bench = be / bi - 1;
      trades.push({ ret, bench, exitDate: k[idx + N].date });
    }
    if (trades.length < 8) {
      console.log(`${String(N).padEnd(4)} ${trades.length.toString().padStart(6)}  样本不足（可用 ${trades.length}，跳过 ${skipped}）`);
      continue;
    }
    const total = trades.reduce((a, t) => a * (1 + t.ret), 1) - 1;
    const excess = trades.reduce((a, t) => a + (t.ret - t.bench), 0) / trades.length;
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
    const sign = excess < 0 ? "（反向）" : "";
    console.log(
      `${String(N).padEnd(4)}` +
        `${trades.length.toString().padStart(6)}` +
        `${(total * 100).toFixed(1)}%`.padStart(9) +
        `${(excess * 100).toFixed(2)}%`.padStart(10) +
        tStr.padStart(8) +
        hsStr.padStart(8) +
        verdict.padStart(10) + sign,
    );
  }
}

async function main() {
  console.log(`龙虎榜反向 edge 席位拆解（成本 0.3%/来回；阈值 ${HM_THRESH}万）`);
  const index = await loadIndex("sh000300");
  const agg = await buildAgg();

  const cats: Cat[] = ["ALL", "INST", "NONINST"];
  for (const cat of cats) {
    const evs = eventsFor(agg, cat);
    await evaluate(cat, evs, index);
  }

  // 部署决策量：现有 ALL 事件里，机构驱动 vs 纯游资驱动的占比
  let instDriven = 0;
  let youziDriven = 0;
  let both = 0;
  let neither = 0;
  for (const rec of agg.values()) {
    if (rec.all < HM_THRESH) continue;
    const i = rec.inst >= HM_THRESH;
    const y = rec.noninst >= HM_THRESH;
    if (i && y) both++;
    else if (i) instDriven++;
    else if (y) youziDriven++;
    else neither++;
  }
  console.log("\n=== 部署决策：现有 ALL 事件（${(instDriven + youziDriven + both + neither)} 个）构成 ===");
  console.log(`  纯机构驱动（inst≥3000，游资<3000）      ：${instDriven}`);
  console.log(`  纯游资驱动（inst<3000，游资≥3000）      ：${youziDriven}`);
  console.log(`  机构+游资都≥3000                        ：${both}`);
  console.log(`  合计≥3000 但两分项都<3000（相互抵消型） ：${neither}`);
  console.log(`  → 若改 INST-only，会被剔除的真实反向事件 = ${instDriven + both}；当前被误杀的纯游资事件 = ${youziDriven}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
