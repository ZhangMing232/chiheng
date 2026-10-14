/**
 * 这个文件是干什么的：
 * 钉住回测运行记录的读取纪律。
 *
 * 重点：
 * 1. **坏行跳过，不整份报废**（历史 JSONL 只追加不改，某次跑崩了就留一行坏的）
 * 2. **校验必须挡住「缺关键字段的行」**——样式为空或 env 不全的行读进页面会渲染出错
 * 3. 新的在前，页面按这个顺序显示
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBacktestRun, loadBacktestRuns, type BacktestRun } from "@/lib/market/backtest-runs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(ranAt: string, alpha: number): BacktestRun {
  return {
    ranAt,
    ranDate: ranAt.slice(0, 10),
    env: { start: "2025-09-18", end: "2026-09-30", days: 250, sample: 300, covered: 296, fillMode: "b", fee: 0.00302, turnoverGate: true, stopPct: null, bench300: -0.051 },
    styles: [{ key: "rebound", label: "中期反转", trades: 2270, winRate: 0.38, avgRet: -0.0003, benchAvg: -0.0019, alpha, tStat: 1.16, beatRate: 0.4, avgHold: 8, worstStreak: 5, drawdown: 0.12 }],
    note: null,
  };
}

/** 建临时目录并把内容写进去。async 是必须的（同步 helper 会让 finally 早于 resolve 跑）。 */
async function withRunsFile<T>(lines: string[], fn: (root: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bt-runs-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "data", "backtest"), { recursive: true });
    await writeFile(join(dir, "data", "backtest", "runs.jsonl"), lines.join("\n"), "utf-8");
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("校验：缺关键字段的行一律判废", () => {
  const good = run("2026-10-12T09:00:00.000Z", 0.001);
  assert.ok(checkBacktestRun(good));
  assert.equal(checkBacktestRun(null), null);
  assert.equal(checkBacktestRun([good]), null, "数组不是一行的形状");
  assert.equal(checkBacktestRun({ ...good, ranAt: undefined }), null);
  assert.equal(checkBacktestRun({ ...good, env: undefined }), null);
  assert.equal(checkBacktestRun({ ...good, env: { ...good.env, fee: "0.3%" } }), null, "费用是字符串 = 口径被改坏了");
  assert.equal(checkBacktestRun({ ...good, styles: [] }), null);
  assert.equal(checkBacktestRun({ ...good, styles: [{ label: "没有 key" }] }), null);
});

test("读取：坏行跳过，好的留下，不整份报废", async () => {
  const lines = [JSON.stringify(run("2026-10-12T09:00:00.000Z", 0.001)), "{ 这不是 json", JSON.stringify({ ranAt: "x" }), JSON.stringify(run("2026-10-10T09:00:00.000Z", 0.002))];
  const { runs, bad } = await withRunsFile(lines, (root) => loadBacktestRuns(root));
  assert.equal(runs.length, 2);
  assert.equal(bad, 2);
});

test("读取：新的在前", async () => {
  const lines = [JSON.stringify(run("2026-10-10T09:00:00.000Z", 0.002)), JSON.stringify(run("2026-10-12T09:00:00.000Z", 0.001))];
  const { runs } = await withRunsFile(lines, (root) => loadBacktestRuns(root));
  assert.deepEqual(runs.map((r) => r.ranDate), ["2026-10-12", "2026-10-10"]);
});

test("读取：文件不存在就是没有，不报错", async () => {
  const { runs, bad } = await loadBacktestRuns(join(tmpdir(), "chiheng-no-such-dir-xyz"));
  assert.deepEqual(runs, []);
  assert.equal(bad, 0);
});