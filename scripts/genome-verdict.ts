/**
 * 这个文件是干什么的：
 * 用**已经跑出来的回测 dump** 给基因组候选判决，并把判决写回
 * data/strategy-genome.json（promoted / rejected / testing）。
 *
 * 为什么单独一个脚本：scripts/strategy-verdict.ts 每天跑一轮全池回测，顺手把
 * 基因组候选也判了（它 BT_GENOME=1 一起注册进同一次回测）。但 sometimes 我们
 * 已经有一份 dump（比如刚跑完的全池判决），只想把判决落盘、不想再跑 20 分钟回测
 * ——这个脚本就是干这个的：不跑回测，只读 dump 写判决。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/genome-verdict.ts <dump.json>
 *
 * 判决门槛 = 白皮书 §4：聚类 |t| ≥ 2 **且**前后半段方向稳定。
 * 样本不够 / 回测没跑成 → 只说「还没结论」，状态留在 testing，不当死了处理。
 */

import { readFile } from "node:fs/promises";
import { readGenome, writeGenome } from "@/lib/market/strategy-genome";
import { applyGenomeVerdict, applyUnjudgeableRejection, judgeGenomeVerdict, verdictFromTrades } from "@/lib/market/genome-verdict";

type Trade = { ret?: number; bench?: number; exitDate?: string };
type Dump = { trades: Record<string, Trade[]> };

const path = process.argv[2];
if (!path) {
  console.error("用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/genome-verdict.ts <dump.json>");
  process.exit(1);
}

let dump: Dump;
try {
  dump = JSON.parse(await readFile(path, "utf8")) as Dump;
} catch (e) {
  console.error(`dump 读失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const keys = Object.keys(dump.trades).filter((k) => k.startsWith("genome_"));
if (keys.length === 0) {
  console.log("dump 里没有 genome_* 的策略——这轮回测没注册基因组候选（要 BT_GENOME=1）。");
  process.exit(0);
}

const file = await readGenome();
let list = file.list;
for (const key of keys) {
  const specId = key.slice("genome_".length);
  const input = verdictFromTrades(dump.trades[key]);
  const outcome = judgeGenomeVerdict(input);
  list = applyGenomeVerdict(list, specId, input);
  console.log(
    `基因组判决 ${specId}：${outcome.status}｜${outcome.reason}` +
      `（笔数 ${input.trades}，超额 ${input.excessPp == null ? "?" : input.excessPp.toFixed(2) + "pp"}，` +
      `聚类 t ${input.clusteredT == null ? "算不出来" : input.clusteredT.toFixed(2)}，` +
      `前后半段同号 ${input.halvesSameSign === null ? "?" : input.halvesSameSign ? "是" : "否"}）`,
  );
}

// 没出现在 dump 里的待判候选：要么回测判不了（缺字段），要么这轮压根没注册。
// 判不了的就标掉——不然它会永远停在 proposed，队列只进不出。
const { specBacktestReady } = await import("@/lib/market/spec-backtest");
const missingById: Record<string, string> = {};
for (const c of file.list) {
  if (c.status !== "proposed" && c.status !== "testing") continue;
  if (keys.some((k) => k.slice("genome_".length) === c.id)) continue;
  const ready = specBacktestReady(c);
  if (!ready.ready) missingById[c.id] = ready.missing.join("；");
}
if (Object.keys(missingById).length > 0) {
  for (const [id, why] of Object.entries(missingById)) {
    console.log(`基因组候选 ${id}：标掉（${why}）`);
  }
  list = applyUnjudgeableRejection(list, missingById);
}

await writeGenome({ list });
console.log("已写回 data/strategy-genome.json");
