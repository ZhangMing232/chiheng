/**
 * #144：市场 regime 择时过滤（BT_FILTER=1）的诚实评价。
 *
 * 门控定义（scripts/backtest.ts 的 bullishAt）：沪深300 收盘价在 20 日均线下方时，
 * 当天不开新仓。等于「指数在均线上才做多，否则空仓」。
 *
 * 【为什么不能只看全池一个数】关过滤时趋势回踩全池超额 −0.38%，开了变 +0.83%
 * （t=1.95，差一点过线）——看着像救活了。但同一开关下反转·原版从 −0.42% 掉到
 * −1.09%、Spring 从 +0.30% 掉到 −0.81%。挑一个好看的策略报数就是自欺。
 * 所以用 #145 立的那把尺子：六个切片（全池全区间 / 前后半段 / 三批抽样）全部判，
 * 要求「全过且方向为正」才算真稳。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/eval-regime.ts
 * 输出：data/backtest/regime/report.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runBacktestSlice, type DumpTrade } from "./lib/backtest-runner.ts";
import { verdictFromTrades, judgeGenomeVerdict, GENOME_MIN_TRADES } from "@/lib/market/genome-verdict";

type Trade = DumpTrade;
type Cell = { n: number; excess: number; t: number | null; promoted: boolean; halves: boolean | null };
type SliceResult = Record<string, Cell>;
type SliceDef = { name: string; env: Record<string, string> };

const OUT_DIR = "data/backtest/regime";
const SLICES: SliceDef[] = [
  { name: "全池·全区间", env: { BT_SAMPLE: "2646" } },
  { name: "全池·前半段", env: { BT_SAMPLE: "2646", BT_HALF: "first" } },
  { name: "全池·后半段", env: { BT_SAMPLE: "2646", BT_HALF: "second" } },
  { name: "抽样·批次0", env: { BT_SAMPLE: "800", BT_OFFSET: "0" } },
  { name: "抽样·批次1", env: { BT_SAMPLE: "800", BT_OFFSET: "1" } },
  { name: "抽样·批次2", env: { BT_SAMPLE: "800", BT_OFFSET: "2" } },
];
const LABELS: Record<string, string> = {
  trend: "趋势回踩", breakout: "放量突破", early: "启动前期", reversal: "反转·原版",
  rev2: "反转·加收阳", rev3: "反转·企稳版", bk2: "突破·早期版", bk3: "突破·排天量",
  bk4: "突破·早期+排天量", rebound: "中期反转", spring: "Spring·威科夫",
};
/** 任务点名的「最强候选」bk2/bk4 家族，单独列。 */
const BK_FAMILY = ["bk2", "bk3", "bk4"];

function judge(trades: Trade[]): Cell {
  const input = verdictFromTrades(trades); // 唯一构造入口：笔数按有效笔算、退化判 null 都在这一处
  const cg = { excess: (input.excessPp ?? 0) / 100, clusterT: input.clusteredT };
  const hs = input.halvesSameSign;
  const v = judgeGenomeVerdict(input);
  return {
    n: trades.length,
    excess: cg ? cg.excess : 0,
    t: cg ? cg.clusterT : null,
    promoted: v.status === "promoted",
    halves: hs,
  };
}

function run(filter: string, sliceIdx: number, slice: SliceDef): Promise<SliceResult> {
  const dumpPath = OUT_DIR + "/slice" + sliceIdx + "_f" + filter + ".json";
  return runBacktestSlice({
    dumpPath,
    label: "BT_FILTER=" + filter + " " + slice.name,
    env: { BT_FILTER: filter, ...slice.env },
  }).then((dump) => {
    const cells: SliceResult = {};
    for (const [k, t] of Object.entries(dump.trades)) cells[k] = judge(t);
    return cells;
  });
}

const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
const tstr = (t: number | null) => (t == null ? "  ?  " : (t >= 0 ? "+" : "") + t.toFixed(2));
const pad = (s: string, n: number) => s.padStart(n);
/** 六切片全过且方向为正，才算「真稳」。 */
function robust(slices: Cell[]): boolean {
  return slices.length === SLICES.length && slices.every((c) => c && c.promoted && c.excess > 0 && c.n >= GENOME_MIN_TRADES);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("#144 regime 择时过滤评价（BT_FILTER=1 = 沪深300 在 MA20 下方不开新仓）");
  console.log("尺子：六个切片全部「过关且超额为正」才算真稳\n");

  // data[filter][sliceName] = SliceResult
  const data: Record<string, Record<string, SliceResult>> = { "0": {}, "1": {} };
  for (let i = 0; i < SLICES.length; i++) {
    for (const f of ["0", "1"]) {
      process.stdout.write("[" + (f === "1" ? "开" : "关") + "] " + SLICES[i].name + " ... ");
      data[f][SLICES[i].name] = await run(f, i, SLICES[i]);
      console.log("完成");
    }
  }

  const keys = Object.keys(data["0"][SLICES[0].name]);
  const cellsOf = (f: string, k: string): Cell[] => SLICES.map((s) => data[f][s.name][k]);
  const report: Record<string, unknown> = {};

  console.log("");
  console.log("=== 关 vs 开：全池全区间 ===");
  console.log("策略".padEnd(18) + pad("关:超额", 10) + pad("关:t", 9) + pad("开:超额", 10) + pad("开:t", 9) + pad("变化", 10) + "  六切片正向全过?");
  console.log("-".repeat(92));
  for (const k of keys) {
    const off = data["0"][SLICES[0].name][k];
    const on = data["1"][SLICES[0].name][k];
    const onSlices = cellsOf("1", k);
    const offSlices = cellsOf("0", k);
    const robustOn = robust(onSlices);
    const robustOff = robust(offSlices);
    const delta = on.excess - off.excess;
    console.log(
      (LABELS[k] ?? k).padEnd(18) +
        pad(pct(off.excess), 10) + pad(tstr(off.t), 9) +
        pad(pct(on.excess), 10) + pad(tstr(on.t), 9) +
        pad(pct(delta), 10) + "  " +
        (robustOn ? "开后真稳 ✓" : robustOff ? "关时真稳、开后毁了" : "都不稳"),
    );
    report[k] = { off, on, delta, robustOff, robustOn, onSlices, offSlices };
  }

  console.log("");
  console.log("=== bk2/bk4 家族专项（任务点名的候选）===");
  for (const k of BK_FAMILY) {
    const on = cellsOf("1", k);
    const off = cellsOf("0", k);
    console.log("  " + (LABELS[k] ?? k));
    console.log("    关：" + off.map((c, i) => SLICES[i].name + " " + pct(c.excess)).join(" / "));
    console.log("    开：" + on.map((c, i) => SLICES[i].name + " " + pct(c.excess)).join(" / "));
    console.log("    → 开过滤后正超额 " + on.filter((c) => c.excess > 0).length + "/6，正向过关 " + on.filter((c) => c.promoted && c.excess > 0).length + "/6");
  }

  const anyRobust = Object.entries(report)
    .filter(([, v]) => (v as { robustOn: boolean }).robustOn)
    .map(([k]) => LABELS[k] ?? k);
  console.log("");
  console.log("=== 结论 ===");
  console.log("开过滤后六切片全过且方向为正的策略：" + (anyRobust.length ? anyRobust.join("、") : "无"));
  const bkRobust = BK_FAMILY.filter((k) => robust(cellsOf("1", k))).length;
  console.log("→ bk2/bk4 家族开过滤后真稳 " + bkRobust + "/" + BK_FAMILY.length + "；" +
    (anyRobust.length === 0 ? "本轮无任何策略达到「真稳」门槛。" : "有策略达到门槛，仍需复核。"));

  await writeFile(
    OUT_DIR + "/report.json",
    JSON.stringify({ at: new Date().toISOString(), slices: SLICES, report }, null, 2),
  );
  console.log("报告已落盘 " + OUT_DIR + "/report.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
