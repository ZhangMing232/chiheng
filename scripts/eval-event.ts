/**
 * #148 事件驱动策略的诚实评价。
 *
 * 五套策略（scripts/backtest.ts 的 BT_EVENT=1）选股条件完全由事件字段触发，
 * 不看价格形态：
 *   融资净买异动 / 融资净偿还 / 融券余额高 / 龙虎榜净卖 / 龙虎榜净买(负对照)
 *
 * 【两把尺子必须同时过】
 * 1. **六切片**（#145 立的地基）：全池 2646 全区间 + 前后半段 + 三批抽样，
 *    全部「聚类 |t|≥2 且前后同向且超额为正」才算真稳。
 *    试跑里「融券余额高」136 笔 +1.94% 逐笔 t=2.90 看着漂亮，正是典型小样本假阳性。
 * 2. **两种事件时间口径**：两融/龙虎榜盘后才公布，t 日 15:00 拿不到、t+1 开盘前拿得到。
 *    BT_EXT_LAG=0 查 t 日事件（合法但依赖盘后数据）；=1 严格滞后一根 K 线。
 *    **结论若只在 lag=0 成立，就是靠前视撑着，不算数。**
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/eval-event.ts
 * 输出：data/backtest/event/report.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runBacktestSlice, type DumpTrade } from "./lib/backtest-runner.ts";
import { verdictFromTrades, judgeGenomeVerdict, GENOME_MIN_TRADES } from "@/lib/market/genome-verdict";

type Trade = DumpTrade;
type Cell = { n: number; excess: number; t: number | null; promoted: boolean; halves: boolean | null };
type SliceResult = Record<string, Cell>;
type SliceDef = { name: string; env: Record<string, string> };

const OUT_DIR = "data/backtest/event";
const SLICES: SliceDef[] = [
  { name: "全池·全区间", env: { BT_SAMPLE: "2646" } },
  { name: "全池·前半段", env: { BT_SAMPLE: "2646", BT_HALF: "first" } },
  { name: "全池·后半段", env: { BT_SAMPLE: "2646", BT_HALF: "second" } },
  { name: "抽样·批次0", env: { BT_SAMPLE: "800", BT_OFFSET: "0" } },
  { name: "抽样·批次1", env: { BT_SAMPLE: "800", BT_OFFSET: "1" } },
  { name: "抽样·批次2", env: { BT_SAMPLE: "800", BT_OFFSET: "2" } },
];
const EVENT_KEYS = ["evt-margin-surge", "evt-margin-exit", "evt-short-high", "evt-lhb-sell", "evt-lhb-buy"];
const LABELS: Record<string, string> = {
  "evt-margin-surge": "融资净买异动",
  "evt-margin-exit": "融资净偿还",
  "evt-short-high": "融券余额高",
  "evt-lhb-sell": "龙虎榜净卖",
  "evt-lhb-buy": "龙虎榜净买(负对照)",
};

function judge(trades: Trade[]): Cell {
  const input = verdictFromTrades(trades); // 唯一构造入口：笔数按有效笔算、退化判 null 都在这一处
  const cg = { excess: (input.excessPp ?? 0) / 100, clusterT: input.clusteredT };
  const hs = input.halvesSameSign;
  const v = judgeGenomeVerdict(input);
  return { n: trades.length, excess: cg ? cg.excess : 0, t: cg ? cg.clusterT : null, promoted: v.status === "promoted", halves: hs };
}

function run(lag: string, sliceIdx: number, slice: SliceDef): Promise<SliceResult> {
  const dumpPath = OUT_DIR + "/slice" + sliceIdx + "_lag" + lag + ".json";
  return runBacktestSlice({
    dumpPath,
    label: "BT_EXT_LAG=" + lag + " " + slice.name,
    env: { BT_EVENT: "1", BT_EXT_LAG: lag, ...slice.env },
    expectKeys: EVENT_KEYS, // 策略没注册必须报错，不许静默变 0 笔
  }).then((dump) => {
    const cells: SliceResult = {};
    for (const k of EVENT_KEYS) cells[k] = judge(dump.trades[k]);
    return cells;
  });
}

const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
const tstr = (t: number | null) => (t == null ? "  ?  " : (t >= 0 ? "+" : "") + t.toFixed(2));
const pad = (s: string, n: number) => s.padStart(n);
function robust(slices: Cell[]): boolean {
  return slices.length === SLICES.length &&
    slices.every((c) => c && c.promoted && c.excess > 0 && c.n >= GENOME_MIN_TRADES);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("#148 事件驱动策略评价（BT_EVENT=1）");
  console.log("尺子一：六切片全过且方向为正；尺子二：lag=0 与 lag=1 结论一致\n");

  // data[lag][sliceName] = SliceResult
  const data: Record<string, Record<string, SliceResult>> = { "0": {}, "1": {} };
  for (const lag of ["0", "1"]) {
    for (let i = 0; i < SLICES.length; i++) {
      process.stdout.write("[lag=" + lag + "] " + SLICES[i].name + " ... ");
      data[lag][SLICES[i].name] = await run(lag, i, SLICES[i]);
      console.log("完成");
    }
  }

  const cellsOf = (lag: string, k: string): Cell[] => SLICES.map((s) => data[lag][s.name][k]);
  const report: Record<string, unknown> = {};

  for (const lag of ["0", "1"]) {
    console.log("");
    console.log("=== BT_EXT_LAG=" + lag + "（" + (lag === "0" ? "查 t 日盘后事件" : "严格滞后一根 K 线") + "）===");
    console.log("策略".padEnd(22) + SLICES.map((s) => pad(s.name.slice(-3), 10)).join("") + pad("正向过关", 10));
    console.log("-".repeat(22 + 60 + 10));
    for (const k of EVENT_KEYS) {
      const cells = cellsOf(lag, k);
      let line = (LABELS[k] ?? k).padEnd(22);
      for (const c of cells) line += pad(c.n < GENOME_MIN_TRADES ? "样本少" : c.promoted && c.excess > 0 ? "正向✓" : c.excess < 0 ? "负向" : "没过", 10);
      line += pad(String(cells.filter((c) => c.promoted && c.excess > 0).length) + "/6", 10);
      console.log(line);
      for (let i = 0; i < SLICES.length; i++) {
        const c = cells[i];
        console.log("    " + SLICES[i].name.padEnd(12) +
          " n=" + String(c.n).padStart(5) +
          " 超额=" + pad(pct(c.excess), 9) +
          " 聚类t=" + pad(tstr(c.t), 8) +
          " 前后=" + (c.halves == null ? "?" : c.halves ? "同向✓" : "翻脸✗"));
      }
    }
  }

  console.log("");
  console.log("=== 两种口径对照 + 结论 ===");
  for (const k of EVENT_KEYS) {
    const r0 = robust(cellsOf("0", k));
    const r1 = robust(cellsOf("1", k));
    const f0 = cellsOf("0", k)[0];
    const f1 = cellsOf("1", k)[0];
    let verdict = "两套口径都不稳";
    if (r0 && r1) verdict = "✓ 真稳：两套口径六切片全过";
    else if (r0 && !r1) verdict = "⚠️ 只在 lag=0 成立 → 靠盘后数据/前视撑着，不算数";
    else if (!r0 && r1) verdict = "只在严格口径成立（罕见，需复查）";
    console.log("  " + (LABELS[k] ?? k).padEnd(22) +
      " 全池超lag0=" + pad(pct(f0.excess), 9) + " t=" + pad(tstr(f0.t), 7) +
      " lag1=" + pad(pct(f1.excess), 9) + " t=" + pad(tstr(f1.t), 7) + " → " + verdict);
    report[k] = { robustLag0: r0, robustLag1: r1, fullLag0: f0, fullLag1: f1, verdict, slicesLag0: cellsOf("0", k), slicesLag1: cellsOf("1", k) };
  }

  const winners = Object.entries(report)
    .filter(([, v]) => (v as { robustLag0: boolean; robustLag1: boolean }).robustLag0 && (v as { robustLag1: boolean }).robustLag1)
    .map(([k]) => LABELS[k] ?? k);
  console.log("");
  console.log("可部署事件策略：" + (winners.length ? winners.join("、") : "无"));
  if (winners.length === 0) console.log("→ 本轮两套时间口径下均无可部署事件策略。");
  else console.log("→ 有候选通过两套口径，仍需检查是否为小样本/切片假阳性。");

  await writeFile(
    OUT_DIR + "/report.json",
    JSON.stringify({ at: new Date().toISOString(), slices: SLICES, report }, null, 2),
  );
  console.log("报告已落盘 " + OUT_DIR + "/report.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
