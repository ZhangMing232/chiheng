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
      { env: { ...process.env, BT_SAMPLE: "2400", BT_NO_LOG: "1", BT_DUMP: dumpPath }, stdio: "inherit" },
    );
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** 逐笔超额（ret - bench）按平仓日聚类的稳健 t。 */
function clusterT(ts: Trade[]): { clusterT: number; excess: number; n: number; days: number } | null {
  const usable = ts.filter((t) => typeof t.ret === "number" && typeof t.bench === "number");
  if (usable.length < 8) return null;
  const exc = usable.map((t) => (t.ret as number) - (t.bench as number));
  const n = exc.length;
  const mean = exc.reduce((s, v) => s + v, 0) / n;
  const byDay = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const d = usable[i].exitDate ?? "";
    const list = byDay.get(d);
    if (list) list.push(exc[i]);
    else byDay.set(d, [exc[i]]);
  }
  let score = 0;
  for (const list of byDay.values()) {
    const s = list.reduce((a, e) => a + (e - mean), 0);
    score += s * s;
  }
  const se = Math.sqrt(score) / n;
  const t = se > 0 ? mean / se : 0;
  return { clusterT: Number(t.toFixed(3)), excess: Number(mean.toFixed(4)), n, days: byDay.size };
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
    const s = clusterT(ts);
    if (s) strategies[key] = s;
  }

  const out = { at: new Date().toISOString(), lookback: 250, universe: 2400, strategies };
  await mkdir(DATA, { recursive: true });
  await writeFile(VERDICT_PATH, JSON.stringify(out, null, 2));

  console.log("回测判决已落盘：");
  for (const [k, v] of Object.entries(strategies).sort((a, b) => a[1].clusterT - b[1].clusterT)) {
    const flag = v.clusterT <= -2 ? " ← 判负（闸门会停用）" : "";
    console.log(`  ${k.padEnd(12)} clusterT=${v.clusterT >= 0 ? "+" : ""}${v.clusterT.toFixed(2)}  excess=${(v.excess * 100).toFixed(2)}pp  n=${v.n} days=${v.days}${flag}`);
  }
}

main().catch((e) => {
  console.error("回测判决刷新失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
