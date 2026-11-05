/**
 * 每日刷新全池回测判决（data/strategy-verdicts.json）。
 *
 * 为什么需要它：策略闸门（strategy-gate）线上只靠「最近 20 笔已平仓」的 t 值判决，
 * 而线上一天最多 10 笔、13 天最多 2 个交易日的样本根本测不出慢亏（raw t 把 2 天
 * 当 20 个独立观测）。全池回测 250 天、几百笔的聚类稳健 t 才有统计功效。
 * 本脚本每天收盘后跑一轮全池回测，算出每套策略的聚类 t，落盘供闸门读。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/strategy-verdict.ts
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const VERDICT_PATH = join(DATA, "strategy-verdicts.json");

type Trade = { exitDate?: string; ret?: number; bench?: number };
type Dump = { trades: Record<string, Trade[]>; env?: Record<string, unknown> };

/** 跑一轮全池回测（BT_DUMP 落临时文件），返回退出码。 */
function runBacktest(dumpPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/backtest.ts"],
      {
        // BT_GENOME=1：把基因组里待判的候选也注册进这轮回测，一次回测判一批。
        // BT_SAMPLE=2646：和 11-05 判决报告的口径一致（全池 2646 只 / 命中 2599），
        // 原来写 2400 —— 2400/2646 是 91% 的池子，判决和报告的数字对不上就不好比了。
        env: { ...process.env, BT_SAMPLE: "2646", BT_NO_LOG: "1", BT_DUMP: dumpPath, BT_GENOME: "1" },
        stdio: "inherit",
      },
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * 逐笔超额（ret - bench）按平仓日聚类的稳健 t。
 * **实现在 src/lib/market/genome-verdict.ts**（和 scripts/cluster-t.py 同口径，已交叉校验），
 * 这里只做转发——两处各写一份算法迟早会漂，判决和报告对不上时最费时间。
 * clusterT 可能是 null（退化样本：簇只有 1 个、或所有笔的超额完全相同 → 方差算不出来）。
 */
async function clusterT(ts: Trade[]): Promise<{ clusterT: number | null; excess: number; n: number; days: number } | null> {
  const { clusterTOf } = await import("@/lib/market/genome-verdict");
  return clusterTOf(ts);
}

async function main() {
  console.log("回测判决刷新开始...\n");
  const dumpPath = join(tmpdir(), `chiheng-verdict-${Date.now()}.json`);
  const code = await runBacktest(dumpPath);
  if (code !== 0) {
    console.error(`回测退出码 ${code}，判决不更新（保留上一份 strategy-verdicts.json）`);
    process.exit(code);
  }
  let dump: Dump;
  try {
    dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
  } catch (e) {
    console.error("回测 dump 读失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  await unlink(dumpPath).catch(() => {});

  const strategies: Record<string, { clusterT: number; excess: number; n: number; days: number }> = {};
  for (const [key, ts] of Object.entries(dump.trades)) {
    const s = await clusterT(ts);
    // clusterT 为 null = 退化样本（簇只有 1 天 / 所有笔超额完全相同），方差算不出来。
    // **不静默丢掉**——大声说出来，让人知道这条策略这轮没有可用判决。
    if (!s) {
      console.error(`  ⚠️ ${key}：聚类 t 算不出来（退化样本），本轮不记判决`);
      continue;
    }
    if (s.clusterT == null) {
      console.error(`  ⚠️ ${key}：聚类 t 算不出来（${s.days} 个平仓日 / 超额无方差），本轮不记判决`);
      continue;
    }
    strategies[key] = { clusterT: s.clusterT, excess: s.excess, n: s.n, days: s.days };
  }

  const out = { at: new Date().toISOString(), lookback: 250, universe: 2646, strategies };
  await mkdir(DATA, { recursive: true });
  await writeFile(VERDICT_PATH, JSON.stringify(out, null, 2));

  console.log("回测判决已落盘：");
  for (const [k, v] of Object.entries(strategies).sort((a, b) => a[1].clusterT - b[1].clusterT)) {
    const flag = v.clusterT <= -2 ? " ← 判负（闸门会停用）" : "";
    console.log(`  ${k.padEnd(12)} clusterT=${v.clusterT >= 0 ? "+" : ""}${v.clusterT.toFixed(2)}  excess=${(v.excess * 100).toFixed(2)}pp  n=${v.n} days=${v.days}${flag}`);
  }

  await writeGenomeVerdicts(dump.trades);
}

/**
 * 基因组候选的判决回写（2026-11-05 补上最后一块拼图）。
 *
 * 为什么必须有：GenomeStatus 里的 promoted / rejected / tombstone 没人写的话，
 * 基因组文件就只进不出——AI 提一批 spec 永远停在 proposed，没人判、没人知道哪套死了，
 * 近亲封禁也学不到「什么死过」。轨道变成只进不出的队列。
 *
 * 判决门槛 = 白皮书 §4：聚类 |t| ≥ 2 **且**前后半段方向稳定。
 * 样本不够 / 回测没跑成 → 只说「还没结论」，状态留在 testing，不当死了处理。
 */
async function writeGenomeVerdicts(trades: Record<string, Trade[]>): Promise<void> {
  const genomeKeys = Object.keys(trades).filter((k) => k.startsWith("genome_"));
  if (genomeKeys.length === 0) return;
  const { readGenome, writeGenome } = await import("@/lib/market/strategy-genome");
  const { applyGenomeVerdict, judgeGenomeVerdict, verdictFromTrades } = await import("@/lib/market/genome-verdict");
  const file = await readGenome();
  let list = file.list;
  for (const key of genomeKeys) {
    const specId = key.slice("genome_".length);
    const ts = trades[key];
    const input = verdictFromTrades(ts);
    const outcome = judgeGenomeVerdict(input);
    list = applyGenomeVerdict(list, specId, input);
    const sorted = [...ts]
      .filter((t) => typeof t.ret === "number" && typeof t.bench === "number")
      .sort((a, b) => (a.exitDate ?? "").localeCompare(b.exitDate ?? ""));
    const half = Math.floor(sorted.length / 2);
    const mean = (rows: Trade[]) =>
      rows.length === 0 ? null : rows.reduce((s, t) => s + ((t.ret as number) - (t.bench as number)), 0) / rows.length;
    const h1 = mean(sorted.slice(0, half));
    const h2 = mean(sorted.slice(half));
    console.log(
      `  基因组判决 ${specId}：${outcome.status}｜${outcome.reason}` +
        `（前半 ${h1 == null ? "?" : (h1 * 100).toFixed(2)}pp / 后半 ${h2 == null ? "?" : (h2 * 100).toFixed(2)}pp）`,
    );
  }
  await writeGenome({ list });
  console.log(`  基因组判决已写回 data/strategy-genome.json`);
}

main().catch((e) => {
  console.error("回测判决刷新失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
