/**
 * #162 正向信号研究：净买是反向，那净卖/特定席位有没有正向可用的？
 *
 * 已确立：龙虎榜「游资/营业部净买 ≥3000万」是**反向**信号（N=55 跑输 7.0%）。
 * 本脚本检验镜像与其他席位分组，看看有没有干净的正向 edge。
 *
 * 假设组（每组都跑净买、净卖两个方向）：
 *   机构 / 拉萨系 / 知名游资 / 其他营业部 / 全体游资(NONINST)
 *   分组规则见 groupOf()；席位名有 7706 种、且部分名字被截断（如"信证券上海分公司"），
 *   所以按关键字归类，未命中的一律进「其他营业部」，不硬猜。
 *
 * 【口径与 live 完全一致】
 *   买入 = 事件日次日开盘价（t+1 open）；卖出 = t+N 收盘价
 *   个股收益 = exit/entry − 1 − COST(0.3% 来回)
 *   超额 = 个股收益 − 沪深300 同期收益（基准事件日收盘 → 出场日收盘）
 *   判决 = clusterTOf + halvesSameSignOf + judgeGenomeVerdict（聚类 |t|≥2 且前后同向）
 *   N = 10 / 20 / 55；样本 <30 笔明确标「样本不足」，不许硬判过关
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-forward-signal.ts
 * 输出：data/backtest/forward-signal/report.json
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict, GENOME_MIN_TRADES } from "@/lib/market/genome-verdict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { codePrefix } from "@/lib/market/code-prefix";

const CACHE = "data/backtest/kline";
const RISK = "data/risk";
const OUT_DIR = "data/backtest/forward-signal";
const COST = 0.003;
const THRESH = 3000; // 万元
const HOLD_DAYS = [10, 20, 55];

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };
type Trade = { ret: number; bench: number; exitDate: string };
type Group = "机构" | "拉萨系" | "知名游资" | "其他营业部" | "全体游资";

const GROUPS: Group[] = ["机构", "拉萨系", "知名游资", "其他营业部", "全体游资"];

function groupOf(name: string): Group {
  if (name === "机构") return "机构";
  if (["拉萨", "昌都", "山南", "西藏"].some((k) => name.includes(k))) return "拉萨系";
  if (["章盟主", "炒股养家", "温州帮", "赵老哥", "宁波桑田路", "作手新一", "小鳄鱼", "方新侠"].some((k) => name.includes(k))) return "知名游资";
  return "其他营业部";
}



async function loadKline(code: string): Promise<Row[]> {
  try {
    const rows = JSON.parse(await readFile(CACHE + "/" + code + ".json", "utf8")) as Row[];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function loadBench(id: string): Promise<Map<string, number>> {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=" + id + ",day,,,400";
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("指数取数失败 " + res.status);
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const m = new Map<string, number>();
  for (const r of body.data?.[id]?.day ?? []) {
    if (Array.isArray(r) && r.length >= 3) m.set(r[0], Number(r[2]));
  }
  return m;
}

/** 一次读盘：按席位组逐票逐日聚合净买（万）。返回 group → Map<"code|date", net>。 */
async function buildAgg(): Promise<Record<Group, Map<string, number>>> {
  const out = {} as Record<Group, Map<string, number>>;
  for (const g of GROUPS) out[g] = new Map();
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(RISK + "/hotmoney-names.json", "utf8"));
  } catch {
    console.log("（没有 hotmoney-names.json，无法映射代码）");
    return out;
  }
  const files = (await readdir(RISK + "/hotmoney")).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    let d: any;
    try { d = JSON.parse(await readFile(RISK + "/hotmoney/" + f, "utf8")); } catch { continue; }
    const date = d.date as string;
    if (!date) continue;
    // 当日按组聚合：group → code → net
    const perGroup = new Map<Group, Map<string, number>>();
    for (const seat of d.seats ?? []) {
      const g = groupOf(seat.name ?? "");
      let gm = perGroup.get(g);
      if (!gm) { gm = new Map(); perGroup.set(g, gm); }
      for (const st of seat.stocks ?? []) {
        const code = codePrefix(names[st.name]);
        if (!code) continue;
        gm.set(code, (gm.get(code) ?? 0) + (Number(st.netWan) || 0));
      }
    }
    // 「全体游资」= 除机构外所有席位之和（与 live 的 NONINST 口径一致）
    const all = new Map<string, number>();
    for (const [g, gm] of perGroup) {
      if (g === "机构") continue;
      for (const [code, net] of gm) all.set(code, (all.get(code) ?? 0) + net);
    }
    perGroup.set("全体游资", all);
    for (const [g, gm] of perGroup) {
      const dest = out[g];
      for (const [code, net] of gm) dest.set(code + "|" + date, net);
    }
  }
  return out;
}

const pad = (s: string, n: number) => s.padStart(n);
const pct = (x: number | null) => (x == null ? "   ?   " : (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%");
const tstr = (t: number | null) => (t == null ? "  ?  " : (t >= 0 ? "+" : "") + t.toFixed(2));

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("正向信号研究：净买是反向，净卖/席位分组有没有正向可用？（阈值 " + THRESH + " 万）");
  const bench = await loadBench("sh000300");
  const agg = await buildAgg();
  console.log("可用基准交易日 " + bench.size + "\n");

  // 预读 K 线
  const codes = new Set<string>();
  for (const g of GROUPS) for (const k of agg[g].keys()) codes.add(k.split("|")[0]);
  const kl = new Map<string, Row[]>();
  for (const c of codes) kl.set(c, await loadKline(c));
  console.log("预读 K 线 " + kl.size + " 只\n");

  const report: Record<string, unknown> = {};

  for (const N of HOLD_DAYS) {
    console.log("=== 持有 N=" + N + " 交易日 ===");
    console.log("组别".padEnd(14) + "方向".padEnd(6) + pad("事件", 8) + pad("笔数", 8) + pad("平均超额", 11) + pad("聚类t", 9) + pad("前后", 9) + pad("判定", 12));
    console.log("-".repeat(80));
    for (const g of GROUPS) {
      for (const dir of ["净买", "净卖"] as const) {
        const evs: { code: string; date: string }[] = [];
        for (const [k, net] of agg[g]) {
          const hit = dir === "净买" ? net >= THRESH : net <= -THRESH;
          if (hit) { const [code, date] = k.split("|"); evs.push({ code, date }); }
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
        const tag = g + "·" + dir;
        if (trades.length < GENOME_MIN_TRADES) {
          console.log(g.padEnd(14) + dir.padEnd(6) + pad(String(evs.length), 8) + pad(String(trades.length), 8) + "  样本不足（<" + GENOME_MIN_TRADES + " 笔），不判决");
          report[tag + "_N" + N] = { events: evs.length, trades: trades.length, status: "样本不足" };
          continue;
        }
        const cg = clusterTOf(trades);
        const hs = halvesSameSignOf(trades);
        const v = judgeGenomeVerdict({
          ran: true, trades: trades.length,
          excessPp: cg ? cg.excess * 100 : null,
          clusteredT: cg ? cg.clusterT : null,
          halvesSameSign: hs,
        });
        const positive = cg != null && cg.excess > 0;
        const verdict = v.status === "promoted"
          ? (positive ? "正向过关 ✓" : "反向过关 ✗")
          : v.status === "rejected" ? "没过 ✗" : "样本不足";
        console.log(
          g.padEnd(14) + dir.padEnd(6) +
            pad(String(evs.length), 8) + pad(String(trades.length), 8) +
            pad(pct(cg ? cg.excess : null), 11) + pad(tstr(cg ? cg.clusterT : null), 9) +
            pad(hs == null ? "?" : hs ? "同向✓" : "翻脸✗", 9) + pad(verdict, 12),
        );
        report[tag + "_N" + N] = {
          events: evs.length, trades: trades.length,
          excess: cg ? cg.excess : null, clusteredT: cg ? cg.clusterT : null,
          halvesSameSign: hs, status: v.status, positive, verdict, reason: v.reason,
        };
      }
    }
    console.log("");
  }

  // 汇总：有没有任何一组「干净的正向信号」= 三个 horizon 都正向、聚类 |t|≥2、前后同向
  console.log("=== 结论 ===");
  const clean: string[] = [];
  for (const g of GROUPS) {
    for (const dir of ["净买", "净卖"] as const) {
      const rows = HOLD_DAYS.map((N) => report[g + "·" + dir + "_N" + N] as {
        status?: string; positive?: boolean; excess?: number | null; clusteredT?: number | null; halvesSameSign?: boolean | null;
      });
      const allPositive = rows.every((r) => r.positive === true);
      const allStrong = rows.every((r) => r.clusteredT != null && r.clusteredT >= 2);
      const allSame = rows.every((r) => r.halvesSameSign === true);
      if (allPositive && allStrong && allSame) clean.push(g + "·" + dir);
    }
  }
  console.log("干净的正向信号（三 horizon 都正向、聚类 t≥2、前后同向）：" + (clean.length ? clean.join("、") : "无"));
  if (clean.length === 0) {
    console.log("→ 本轮未发现干净的正向信号；反向信号的镜像并不自动是正向信号，龙虎榜事件整体仍是「回避」而非「选入」的料。");
  } else {
    console.log("→ 发现候选正向信号，需在策略层复核覆盖面与样本外后再谈部署。");
  }

  await writeFile(OUT_DIR + "/report.json", JSON.stringify({ at: new Date().toISOString(), thresh: THRESH, holdDays: HOLD_DAYS, report, cleanForward: clean }, null, 2));
  console.log("报告已落盘 " + OUT_DIR + "/report.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
