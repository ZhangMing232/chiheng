/**
 * #163 offset1 反向归因：为什么换一批抽样，回避过滤器就不灵了？
 *
 * 背景：BT_SAMPLE=800 等距抽样（step=3），BT_OFFSET=0/1/2 是三批互不重叠的票。
 * 固定 W=80、THRESH=3000 时，趋势回踩超额：
 *   offset0 −0.05% → +0.31%（改善）；offset1 −0.31% → −0.12%（没改善/更差）；
 *   offset2 +0.09% → +0.23%（改善）。换阈值也救不了 offset1。
 *
 * 本脚本用「关过滤器」那轮的逐笔 dump 反算：哪些成交票会被 shouldAvoid 挡掉，
 * 这些票**如果不挡**真实收益是多少。挡对了（被挡票跑输）还是挡错了（被挡票跑赢），
 * 一眼见分晓。再按时间切段、扩展更多 offset，判断是抽样运气还是市场结构。
 *
 * 【口径】和 live 完全一致：loadAvoidIndex() 默认 noninst、LHB_THRESH=3000、
 * shouldAvoid(id, 信号日, W=80 自然日)。逐笔超额 = ret − bench（回测引擎算好的）。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/diag-offset1.ts
 * 输出：data/backtest/offset1-diag/report.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { runBacktestSlice, type DumpTrade } from "./lib/backtest-runner.ts";
import { loadAvoidIndex } from "@/lib/market/lhb-avoid-index.server";
import { shouldAvoid } from "@/lib/market/lhb-avoid";

type Trade = DumpTrade & { id: string; date: string; ret: number; bench: number };

const OUT_DIR = "data/backtest/offset1-diag";
const WIN = 80;
// ⚠️ 抽样周期：step = floor(池子 2645 / SAMPLE 800) = 3，
// `(i + offset) % step` 的周期就是 step，所以 offset 0/3/6 是同一批、1/4/7 同一批、2/5/8 同一批。
// **只有 3 个互不重叠的独立批次**，扫 6 个 offset 会得到 2 份重复数据，
// 拿它算 t 是假的。要更多独立批次只能改 BT_SAMPLE（step 变大）或改抽样方式。
const INDEPENDENT_OFFSETS = [0, 1, 2];
const ALL_OFFSETS = [0, 1, 2, 3, 4, 5]; // 保留 3/4/5 用来**证明**周期性，不参与统计
const SAMPLE = "800";
const STRAT = "trend"; // 趋势回踩，前几轮焦点

function run(avoid: boolean, offset: number): Promise<Record<string, Trade[]>> {
  const dumpPath = OUT_DIR + "/off" + offset + "_" + (avoid ? "on" : "off") + ".json";
  return runBacktestSlice({
    dumpPath,
    label: "off" + offset + " " + (avoid ? "开过滤" : "关过滤"),
    env: {
      BT_SAMPLE: SAMPLE, BT_OFFSET: String(offset),
      BT_AVOID_WIN: String(WIN), LHB_THRESH: "3000",
      ...(avoid ? { BT_AVOID_LHB: "1" } : {}),
    },
    unsetEnv: avoid ? [] : ["BT_AVOID_LHB"],
    expectKeys: [STRAT],
  }).then((d) => d.trades as Record<string, Trade[]>);
}

const pad = (s: string, n: number) => s.padStart(n);
const pct = (x: number) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const excessOf = (ts: Trade[]) => mean(ts.map((t) => t.ret - t.bench));

function board(id: string): string {
  if (id.startsWith("sh68")) return "科创";
  if (id.startsWith("sh6")) return "沪主";
  if (id.startsWith("sz30")) return "创业";
  if (id.startsWith("sz00")) return "深主";
  if (id.startsWith("bj")) return "北交";
  return "其他";
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("#163 offset1 反向归因（W=" + WIN + " 自然日，THRESH=3000万，趋势回踩）\n");

  // 用与 live 完全相同的索引（noninst 口径）
  const index = await loadAvoidIndex();
  let totalEvents = 0;
  for (const arr of index.values()) totalEvents += arr.length;
  console.log("回避索引：涉及 " + index.size + " 只票，共 " + totalEvents + " 票·日事件\n");

  const report: Record<string, unknown> = {};

  console.log("=== 1) 各批次：关过滤的成交里，被挡票本身是好是坏 ===");
  console.log("批次".padEnd(8) + pad("关笔数", 8) + pad("票只数", 8) + pad("会被挡笔数", 12) +
    pad("挡票超额", 11) + pad("留票超额", 11) + pad("差值", 10) + "  判定");
  console.log("-".repeat(88));
  for (const off of ALL_OFFSETS) {
    const offDump = await run(false, off);
    const ts = offDump[STRAT] ?? [];
    const blocked = ts.filter((t) => shouldAvoid(t.id, t.date, WIN));
    const kept = ts.filter((t) => !shouldAvoid(t.id, t.date, WIN));
    const exBlocked = excessOf(blocked);
    const exKept = excessOf(kept);
    const ids = new Set(ts.map((t) => t.id));
    const boards: Record<string, number> = {};
    for (const id of ids) boards[board(id)] = (boards[board(id)] ?? 0) + 1;
    const good = blocked.length > 0 && exBlocked < exKept;
    console.log(
      ("off" + off).padEnd(8) + pad(String(ts.length), 8) + pad(String(ids.size), 8) +
        pad(String(blocked.length), 12) + pad(pct(exBlocked), 11) + pad(pct(exKept), 11) +
        pad(pct(exBlocked - exKept), 10) + "  " + (blocked.length === 0 ? "无挡票" : good ? "挡对了 ✓" : "挡错了 ✗"),
    );
    report["off" + off] = { n: ts.length, ids: ids.size, boards, blocked: blocked.length, exBlocked, exKept, delta: exBlocked - exKept };
  }

  console.log("");
  console.log("=== 2) 各批次：开/关过滤的真实增益，以及前后半段 ===");
  console.log("批次".padEnd(8) + pad("关超额", 10) + pad("开超额", 10) + pad("增益", 10) +
    pad("前半增益", 11) + pad("后半增益", 11) + pad("开笔数", 9));
  console.log("-".repeat(78));
  const mid = "2026-05-01"; // 回测区间 2025-10-28 ~ 2026-11-06 的中点附近
  for (const off of ALL_OFFSETS) {
    const dOff = await run(false, off);
    const dOn = await run(true, off);
    const a = dOff[STRAT] ?? [];
    const b = dOn[STRAT] ?? [];
    const exOff = excessOf(a);
    const exOn = excessOf(b);
    const seg = (arr: Trade[], first: boolean) => arr.filter((t) => (t.date < mid) === first);
    const g1 = excessOf(seg(b, true)) - excessOf(seg(a, true));
    const g2 = excessOf(seg(b, false)) - excessOf(seg(a, false));
    console.log(
      ("off" + off).padEnd(8) + pad(pct(exOff), 10) + pad(pct(exOn), 10) + pad(pct(exOn - exOff), 10) +
        pad(pct(g1), 11) + pad(pct(g2), 11) + pad(String(b.length), 9),
    );
    (report["off" + off] as Record<string, unknown>).gain = {
      exOff, exOn, delta: exOn - exOff, firstHalf: g1, secondHalf: g2, nOn: b.length,
    };
  }

  console.log("");
  console.log("=== 3) 批次构成差异（代码段分布）===");
  for (const off of ALL_OFFSETS) {
    const r = report["off" + off] as { boards: Record<string, number>; ids: number };
    console.log("  off" + off + " 票只 " + r.ids + "：" +
      Object.entries(r.boards).map(([k, v]) => k + " " + v + "(" + ((v / r.ids) * 100).toFixed(0) + "%)").join("  "));
  }

  const gains = INDEPENDENT_OFFSETS.map((o) => (report["off" + o] as { gain: { delta: number } }).gain.delta);
  console.log("");
  console.log("=== 结论 ===");
  console.log("⚠️ 抽样周期 = step = 3：off3/4/5 就是 off0/1/2 的重复，不是独立样本。");
  console.log("   独立批次只有 " + INDEPENDENT_OFFSETS.length + " 个（BT_SAMPLE=" + SAMPLE + "）。");
  console.log("独立批次中过滤器增益为正的 " + gains.filter((g) => g > 0).length + " 批、为负的 " + gains.filter((g) => g <= 0).length + " 批");
  console.log("增益 " + gains.map((g) => pct(g)).join(" / ") + "，均值 " + pct(mean(gains)));
  console.log("");
  console.log("【历史纠正（背景说明，非本轮计算结果）】前几轮把「开过滤后超额仍为负」误读成「过滤器反向」——那是错的；");
  console.log("  当时 offset1 关过滤 −0.31% → 开过滤 −0.12%，是改善 +0.19%，只是没好到转正。");
  console.log("  判过滤器好坏要看「开 − 关」增益，不是开之后的绝对值。下面数字以本轮实跑为准。");
  console.log("");
  console.log("【本轮实跑】被挡票跑输留票的批次 " + INDEPENDENT_OFFSETS.filter((o) => (report["off" + o] as { delta: number }).delta < 0).length +
    "/" + INDEPENDENT_OFFSETS.length + "；增益为正 " + gains.filter((g) => g > 0).length + "/" + gains.length + " 批。");
  console.log("【上线资格】" + (gains.every((g) => g > 0)
    ? "增益方向一致为正，但闸门默认关的理由仍成立：全区间 t 不过双闸、独立批次仅 3 个、仅趋势回踩受益。"
    : "批次间增益有正有负，不足以支撑上线。"));

  await writeFile(OUT_DIR + "/report.json", JSON.stringify({ at: new Date().toISOString(), win: WIN, sample: SAMPLE, offsets: ALL_OFFSETS, independentOffsets: INDEPENDENT_OFFSETS, report }, null, 2));
  console.log("报告已落盘 " + OUT_DIR + "/report.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
