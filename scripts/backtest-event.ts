/**
 * 方向 B：事件驱动。用 backtest.ts 早就读进来却从没用过的另类数据当信号源——
 * 龙虎榜净买（游资/营业部驱动的反向信号）、两融（融资余额）异动。和老六套的本质区别：
 * 信号不是价格/量形态，而是「有信息优势的参与者在干嘛」。骨架彻底换。
 *
 * 做法（事件研究法）：
 *   1. 把两类数据翻成「事件」——某只票在某天出现了强龙虎榜净买 / 融资余额暴涨。
 *      （席位拆解见 backtest-lhb-seats.ts：该反向信号由游资/营业部驱动，机构净买单独不反向。）
 *   2. 事件日 t 收盘出信号，t+1 开盘买入，持有 N 个交易日，t+N 收盘卖出。
 *   3. 每笔超额 = 个股收益 − 同期沪深300收益。信噪比 + 前后同向，过白皮书两道关才算站住。
 *
 * 取数口径：
 *   - 个股日线用 data/backtest/kline 本地缓存（和 backtest.ts 同一份，不重新抓）。
 *   - 基准用沪深300（sh000300）当日序列。
 *
 * 阈值都是第一刀，先看出有没有信号，再谈调参：
 *   - 龙虎榜：所有披露席位对该股净买合计 ≥ HM_THRESH 万元（默认 3000万）算事件（游资/营业部驱动的反向信号）。
 *   - 两融：融资余额日环比 ≥ MARGIN_THRESH（默认 8%）算事件。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-event.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { readFile, readdir } from "node:fs/promises";
import { codePrefix } from "@/lib/market/code-prefix";

const CACHE = "data/backtest/kline";
const RISK = "data/risk";
const COST = 0.003; // 一来一回 0.3%（股票双边费 + 滑点粗估）
const HOLD_DAYS = [5, 10, 20];
const HM_THRESH = Number(process.env.HM_THRESH ?? 3000); // 万元
const MARGIN_THRESH = Number(process.env.MARGIN_THRESH ?? 0.08); // 融资余额日环比

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
type Event = { code: string; date: string; kind: "hm" | "margin"; mag: number };

// 风险数据里的代码是无前缀的 6 位（"601318"），但 kline 缓存文件名带前缀（"sh601318.json"）。
// 不补前缀，loadKline 永远找不到文件 —— 这就是上一版 0 可用笔数的根因。


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

async function buildEvents(): Promise<Event[]> {
  const events: Event[] = [];

  // 龙虎榜：所有披露席位对该股净买合计 ≥ 阈值 → 事件
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(`${RISK}/hotmoney-names.json`, "utf8"));
  } catch {
    console.log("（没有 hotmoney-names.json，龙虎榜事件无法映射代码，跳过）");
  }
  const hmFiles = (await readdir(`${RISK}/hotmoney`)).filter((f) => f.endsWith(".json")).map((f) => `${RISK}/hotmoney/${f}`).sort();
  let hmSkippedName = 0;
  for (const f of hmFiles) {
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
          hmSkippedName += 1;
          continue;
        }
        const pcode = codePrefix(code);
        agg[pcode] = (agg[pcode] ?? 0) + (Number(st.netWan) || 0);
      }
    }
    for (const [code, net] of Object.entries(agg)) {
      if (net >= HM_THRESH) events.push({ code, date, kind: "hm", mag: net });
    }
  }

  // 两融：融资余额日环比暴涨 → 事件（跟踪每只票上一交易日的余额）
  const mgFiles = (await readdir(`${RISK}/margin`)).filter((f) => f.endsWith(".json")).map((f) => `${RISK}/margin/${f}`).sort();
  const prevRzye: Record<string, number> = {};
  for (const f of mgFiles) {
    let d: any;
    try {
      d = JSON.parse(await readFile(f, "utf8"));
    } catch {
      continue;
    }
    const date: string = d.date;
    if (!date) continue;
    for (const row of d.rows ?? []) {
      const code: string = codePrefix(row.id);
      const cur = Number(row.rzye);
      const p = prevRzye[code];
      if (p != null && p > 0) {
        const pct = (cur - p) / p;
        if (pct >= MARGIN_THRESH) events.push({ code, date, kind: "margin", mag: pct });
      }
      prevRzye[code] = cur;
    }
  }

  console.log(
    `事件总数 ${events.length}（龙虎榜 ${events.filter((e) => e.kind === "hm").length} · 两融 ${events.filter((e) => e.kind === "margin").length}；龙虎榜未映射名称 ${hmSkippedName} 次）`,
  );
  return events;
}

async function evaluate(events: Event[], index: Map<string, number>) {
  const byKind = { hm: events.filter((e) => e.kind === "hm"), margin: events.filter((e) => e.kind === "margin") };
  for (const kind of ["hm", "margin"] as const) {
    const label = kind === "hm" ? "龙虎榜净买（游资驱动反向）" : "两融融资余额异动";
    console.log(`\n=== ${label} ===`);
    console.log("持有   笔数    总收益   平均超额  信噪比   前后半段   两道关判定");
    console.log("-".repeat(72));
    const evs = byKind[kind];
    if (evs.length === 0) {
      console.log("（无事件）");
      continue;
    }
    // 预读相关个股日线（去重）
    const codes = [...new Set(evs.map((e) => e.code))];
    const klines = new Map<string, Row[]>();
    for (const code of codes) klines.set(code, await loadKline(code));

    for (const N of HOLD_DAYS) {
      const trades: { ret: number; bench: number; exitDate: string }[] = [];
      let skipped = 0;
      for (const ev of evs) {
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
        const entry = k[idx + 1].o; // t+1 开盘买入（无前视）
        const exit = k[idx + N].c; // t+N 收盘卖出
        if (!(entry > 0)) {
          skipped += 1;
          continue;
        }
        const ret = exit / entry - 1 - COST;
        const bi = index.get(ev.date);
        const be = index.get(k[idx + N].date);
        if (bi == null || be == null || !(bi > 0)) {
          skipped += 1;
          continue;
        }
        const bench = be / bi - 1;
        trades.push({ ret, bench, exitDate: k[idx + N].date });
      }
      if (trades.length < 8) {
        console.log(`${String(N).padEnd(4)} ${(trades.length).toString().padStart(6)}  样本不足（可用 ${trades.length}，跳过 ${skipped}）`);
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
      console.log(
        `${String(N).padEnd(4)}` +
          `${trades.length.toString().padStart(6)}` +
          `${(total * 100).toFixed(1)}%`.padStart(9) +
          `${(excess * 100).toFixed(2)}%`.padStart(10) +
          tStr.padStart(8) +
          hsStr.padStart(8) +
          verdict.padStart(10),
      );
    }
  }
}

async function main() {
  console.log(`事件驱动回测（成本估算 0.3%/来回；龙虎榜阈值 ${HM_THRESH}万，两融环比 ${MARGIN_THRESH * 100}%）`);
  const index = await loadIndex("沪深300", "sh000300");
  const events = await buildEvents();
  await evaluate(events, index);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
