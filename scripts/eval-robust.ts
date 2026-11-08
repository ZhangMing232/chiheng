/**
 * 统一策略评价器（#145 的地基）。
 *
 * 为什么要单独一个入口：判决零件早就有（全池 2646 / 聚类稳健 t / BT_HALF / BT_OFFSET），
 * 但散在 strategy-verdict.ts、backtest.ts、各次手写扫描里，每次优化各自挑一个顺眼的
 * 切片报数 → spring 那种「60 笔 t=+2.08 看着能部署、300 笔 −0.61」的小样本假阳性
 * 就是这么混进来的。#150 术语统一后，这里把「大样本 + 样本外 + 多批次」钉成一把尺子：
 *
 *   大样本  = BT_SAMPLE=2646（全池，不抽样）
 *   样本外  = BT_HALF=first / second（前后半段各自独立判）
 *   多批次  = BT_OFFSET=0/1/2 各 800 只，互不重叠
 *   最小样本 = GENOME_MIN_TRADES(30)，低于不判生死
 *   判决    = clusterTOf（按平仓日聚类）+ halvesSameSignOf + judgeGenomeVerdict
 *
 * **最终只有「全池全区间过关 + 前后半段各自同向 + 三批都不翻脸」才算真稳。**
 * 任何单点好看、换个切片就翻的，一律标「小样本/切片假阳性」，不能拿去部署。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/eval-robust.ts
 * 输出：data/backtest/robust/<日期>/report.json + 控制台矩阵
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runBacktestSlice, type DumpTrade } from "./lib/backtest-runner.ts";
import { buildSlices } from "./lib/eval-slices.ts";
import { verdictFromTrades, judgeGenomeVerdict, GENOME_MIN_TRADES } from "@/lib/market/genome-verdict";

type Trade = DumpTrade;

const OUT_DIR = "data/backtest/robust/" + new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** BT_ONLY=<key1,key2> 时只判指定策略（用于单独验收某个实验策略，避免被基线 11 套污染矩阵）。空=全判。 */
const ONLY = (process.env.BT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** 六个切片。sample=2646 是全池；offset 仅在抽样时才有意义。BT_SAMPLE 可整体覆盖（小样本先验证链路）。
 *  定义在 scripts/lib/eval-slices.ts（纯函数），守门测试直接 import 它断言真实切片，
 *  不再靠「源码里必须出现某字符串」这种脆断言。 */
const SLICES = buildSlices();

const LABELS: Record<string, string> = {
  trend: "趋势回踩",
  breakout: "放量突破",
  early: "启动前期",
  reversal: "反转·原版",
  rev2: "反转·加收阳",
  rev3: "反转·企稳版",
  bk2: "突破·早期版",
  bk3: "突破·排天量",
  bk4: "突破·早期+排天量",
  rebound: "中期反转",
  spring: "Spring·威科夫",
  relValPersist: "相对估值分位·持续",
};

type Cell = {
  n: number;
  excess: number | null;
  clusteredT: number | null;
  halvesSameSign: boolean | null;
  status: "promoted" | "rejected" | "testing" | string;
  reason: string;
};

function judge(trades: Trade[]): Cell {
  const input = verdictFromTrades(trades); // 唯一构造入口：笔数按有效笔算、退化判 null 都在这一处
  const cg = { excess: (input.excessPp ?? 0) / 100, clusterT: input.clusteredT };
  const hs = input.halvesSameSign;
  const v = judgeGenomeVerdict(input);
  return {
    n: trades.length,
    excess: cg ? cg.excess : null,
    clusteredT: cg ? cg.clusterT : null,
    halvesSameSign: hs,
    status: v.status,
    reason: v.reason,
  };
}

function runSlice(slice: { name: string; env: Record<string, string> }, dumpPath: string): Promise<Record<string, Trade[]>> {
  return runBacktestSlice({ dumpPath, label: slice.name, env: slice.env }).then((d) => d.trades);
}

const fmtT = (t: number | null) => (t == null ? "  ?  " : (t >= 0 ? "+" : "") + t.toFixed(2));
const fmtP = (x: number | null) => (x == null ? "   ?   " : (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%");
/**
 * 单元格标记。⚠️ judgeGenomeVerdict 判的是 |t|≥2，**稳定亏钱也算 promoted**
 * （放量突破全池 t=−2.11、超额 −0.43%，判决是「过关」但它是稳定负 alpha）。
 * 所以对多头策略必须把方向单独标出来：负向过关 ≠ 可部署，别让矩阵自己造出假阳性。
 */
const mark = (c: Cell | undefined) => {
  if (!c) return "  -  ";
  if (c.n < GENOME_MIN_TRADES) return "样本少";
  if (c.status === "testing") return " 待判?";
  if (c.status === "promoted") {
    return c.excess != null && c.excess < 0 ? "负向过关" : " 正向✓ ";
  }
  return c.clusteredT != null && c.clusteredT < 0 ? " 反向✗" : " 没过✗";
};
const pad = (s: string, n: number) => s.padStart(n);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("统一策略评价器：大样本 + 样本外 + 多批次");
  console.log("判决：聚类 |t|≥2 且前后同向；最小 " + GENOME_MIN_TRADES + " 笔；低于不判生死\n");

  const bySlice: Record<string, Record<string, Cell>> = {};
  for (let i = 0; i < SLICES.length; i++) {
    const slice = SLICES[i];
    process.stdout.write("[" + (i + 1) + "/" + SLICES.length + "] " + slice.name + " ... ");
    const tradesByStrategy = await runSlice(slice, OUT_DIR + "/slice" + i + ".json");
    const cells: Record<string, Cell> = {};
    for (const [key, trades] of Object.entries(tradesByStrategy)) cells[key] = judge(trades);
    bySlice[slice.name] = cells;
    console.log("完成（" + Object.keys(cells).length + " 套策略）");
  }

  // 矩阵：每策略 × 每切片，打印超额 / 聚类t / 判定
  console.log("");
  console.log("=== 判决矩阵（单元格 = 判定；括号内 = 超额 / 聚类t）===");
  console.log("策略".padEnd(18) + SLICES.map((s) => pad(s.name, 12)).join(""));
  console.log("-".repeat(18 + 12 * SLICES.length));
  const summary: Record<string, { robust: boolean; positive: number; validated: number; note: string }> = {};
  let keys = Object.keys(bySlice[SLICES[0].name]);
  if (ONLY.length) {
    const unknown = ONLY.filter((k) => !keys.includes(k));
    if (unknown.length) console.warn("⚠️ BT_ONLY 含未知策略：" + unknown.join(", ") + "（有效：" + keys.join(", ") + "）");
    keys = keys.filter((k) => ONLY.includes(k));
    console.log("BT_ONLY 过滤：仅判 " + keys.join(", ") + "\n");
  }
  for (const key of keys) {
    let line = (LABELS[key] ?? key).padEnd(18);
    let positive = 0;
    let validated = 0;
    for (const s of SLICES) {
      const c = bySlice[s.name][key];
      line += pad(mark(c), 12);
      if (c && c.status === "promoted") positive++;
      if (c && c.n >= GENOME_MIN_TRADES) validated++;
    }
    console.log(line);
    // 真稳 = 六个切片全过关，且方向一致为正
    const cells = SLICES.map((s) => bySlice[s.name][key]);
    const allPromoted = cells.every((c) => c && c.status === "promoted");
    const allPositive = cells.every((c) => c && c.excess != null && c.excess > 0);
    const full = cells[0];
    const halfOk = cells[1]?.halvesSameSign === true && cells[2]?.halvesSameSign === true;
    const batchesOk = cells.slice(3).every((c) => c && c.clusteredT != null && c.clusteredT > 0);
    const robust = allPromoted && allPositive && halfOk && batchesOk;
    let note = "";
    if (!robust) {
      if (full?.status !== "promoted") note = "全池全区间就没过关";
      else if (!halfOk) note = "前后半段不同向，样本外站不住";
      else if (!batchesOk) note = "抽样批次间翻脸";
      else if (!allPositive) note = "存在负超额切片";
      else note = "未全切片过关";
    } else note = "六切片全过且同向";
    summary[key] = { robust, positive, validated, note };
    console.log("  " + (LABELS[key] ?? key) + "：" +
      "全池 超额 " + fmtP(full?.excess ?? null) + " / t " + fmtT(full?.clusteredT ?? null) +
      "；过关切片 " + positive + "/6；结论 " + (robust ? "真稳 ✓" : "不稳 ✗ — " + note));
    for (const s of SLICES) {
      const c = bySlice[s.name][key];
      if (!c) continue;
      console.log("    " + s.name.padEnd(12) +
        " n=" + String(c.n).padStart(5) +
        " 超额=" + fmtP(c.excess) +
        " t=" + fmtT(c.clusteredT) +
        " 前后=" + (c.halvesSameSign == null ? "?" : c.halvesSameSign ? "同向✓" : "翻脸✗") +
        " " + c.reason);
    }
  }

  const robustList = Object.entries(summary)
    .filter(([, v]) => v.robust)
    .map(([k]) => LABELS[k] ?? k);
  const negativePromoted = Object.entries(bySlice[SLICES[0].name])
    .filter(([, c]) => c.status === "promoted" && c.excess != null && c.excess < 0)
    .map(([k]) => (LABELS[k] ?? k) + "(全池 " + fmtP(bySlice[SLICES[0].name][k].excess) + ")");
  console.log("");
  console.log("=== 总结 ===");
  console.log("真稳（六切片全过且同向为正）：" + (robustList.length ? robustList.join("、") : "无"));
  if (negativePromoted.length) {
    console.log("⚠️ 全池「过关」但方向为负（稳定亏钱，不是 alpha，不能部署）：" + negativePromoted.join("、"));
    console.log("   判决函数判的是 |t|≥2，负向也算 promoted；做多必须自己看超额符号。");
  }
  console.log("其余全部标记不稳，不得据此部署。小样本假阳性的典型形态 = 某个切片好看、换切片就翻。");

  await writeFile(
    OUT_DIR + "/report.json",
    JSON.stringify({
      at: new Date().toISOString(),
      slices: SLICES.map((s) => ({ name: s.name, env: s.env })),
      labels: LABELS,
      bySlice,
      summary,
    }, null, 2),
  );
  console.log("\n报告已落盘 " + OUT_DIR + "/report.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
