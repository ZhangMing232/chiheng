/**
 * 这个文件是干什么的：
 * 钉住因子研究那两份产物的读取行为（factor-runs.jsonl / factor-diag.jsonl / baseline-*.txt）。
 *
 * 为什么要单独一个文件：
 * 这批数据是「页面能不能说人话」的地基，而它有三处特别容易静默出错——
 *   1. 批次分组：同一次跑的 25 条，at 相差几毫秒，分组错了会把一批劈成两半
 *   2. 读不到文件时返回空数组冒充「0 个因子」——那是撒谎，真情况是「没跑过」
 *   3. 坏行把整份日志废掉
 * 这三件事读代码看不出来，只能靠测试钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterByBatch,
  readFactorRuns,
  readFactorDiag,
  readBaseline,
  type FactorRunRow,
} from "@/lib/market/factor-runs-file";

/**
 * 临时数据目录。必须是 async 的——读取函数是 async 的，如果这里写成同步的
 * `return fn(dir)`，finally 会在 Promise resolve 之前就把目录删掉、把环境变量
 * 还原，读到的自然是「文件不存在」。（gate-log.test.ts 里那份是同步的，因为
 * 它测的 readGateLogs 是同步的；这里照搬会静默失败。）
 */
async function withTempDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-factor-"));
  mkdirSync(join(dir, "backtest"), { recursive: true });
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一条因子结果行。nTested 默认 25。 */
function run(overrides: Partial<FactorRunRow> = {}): FactorRunRow {
  return {
    at: "2026-10-07T04:29:53.000Z",
    factor: "shrinkDays",
    name: "缩量天数",
    direction: -1,
    n: 10,
    buckets: 5,
    offset: 0,
    nDays: 240,
    meanSpread: -0.0055,
    t: -4.35,
    topBlockedRatio: 0.27,
    bucketMeans: [0.004, 0.0016, 0.0016, 0.0001, -0.0015],
    resampleSpread: -0.006,
    resampleT: -2.1,
    gates: { g1: true, g2: true, g3: false, g4: true, g5: true, g6: true },
    nTested: 25,
    ...overrides,
  };
}

function writeRuns(dir: string, rows: FactorRunRow[]) {
  writeFileSync(join(dir, "backtest", "factor-runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

test("批次分组：相差几毫秒的同一批不能被劈开", () => {
  // 真实日志里同一批的 at 是逐条 new Date().toISOString()，实测有 .500Z / .501Z 混在一批里。
  // 用字符串严格相等分组会把这 25 条劈成两半。
  const rows = [
    { at: "2026-10-07T04:29:53.500Z" },
    { at: "2026-10-07T04:29:53.501Z" },
    { at: "2026-10-07T04:29:53.502Z" },
  ];
  const batches = clusterByBatch(rows);
  assert.equal(batches.length, 1, "相差 1~2 毫秒必须算同一批");
  assert.equal(batches[0].length, 3);
});

test("批次分组：跨秒边界也不能丢行", () => {
  // 只截到秒分组会在 xx:59.999 / xy:00.001 这种边界上丢行，所以要用容差而不是截字符串。
  const rows = [
    { at: "2026-10-07T04:29:59.998Z" },
    { at: "2026-10-07T04:30:00.001Z" },
  ];
  assert.equal(clusterByBatch(rows).length, 1, "跨秒 3 毫秒应算同一批");
});

test("批次分组：真的隔了很久就是两批", () => {
  const rows = [
    { at: "2026-10-06T15:41:30.000Z" },
    { at: "2026-10-07T04:29:53.000Z" },
  ];
  assert.equal(clusterByBatch(rows).length, 2);
});

test("读不到文件时给 why，不返回空数组冒充「0 个因子」", async () => {
  await withTempDataDir(async () => {
    const out = await readFactorRuns();
    assert.equal(out.batch, null, "没有数据就是没有数据，不能给一个空批次");
    assert.ok(out.missing, "必须说清为什么读不到");
    assert.match(out.missing, /factor-runs\.jsonl/);
  });
});

test("两批日志取最新的一批", async () => {
  await withTempDataDir(async (dir) => {
    const old = Array.from({ length: 22 }, (_, i) => run({ at: "2026-10-06T15:41:30.000Z", factor: `old${i}`, nTested: 22 }));
    const fresh = Array.from({ length: 25 }, (_, i) => run({ at: "2026-10-07T04:29:53.000Z", factor: `new${i}` }));
    writeRuns(dir, [...old, ...fresh]);

    const out = await readFactorRuns();
    assert.equal(out.batches.length, 2, "日志里有两批");
    assert.equal(out.batch?.rows.length, 25, "页面看的是最新那批");
    assert.equal(out.batch?.nTested, 25);
  });
});

test("按索引回看任意一批：0=最旧，越界回退最新，批次列表带参数标签", async () => {
  await withTempDataDir(async (dir) => {
    const old = Array.from({ length: 22 }, (_, i) =>
      run({ at: "2026-10-06T15:41:30.000Z", factor: `old${i}`, n: 3, nTested: 22 }),
    );
    const fresh = Array.from({ length: 25 }, (_, i) =>
      run({ at: "2026-10-07T04:29:53.000Z", factor: `new${i}`, n: 20, offset: 1 }),
    );
    writeRuns(dir, [...old, ...fresh]);

    const first = await readFactorRuns(0);
    assert.equal(first.batchIndex, 0);
    assert.equal(first.batch?.rows[0].factor, "old0", "索引 0 回放到最旧一批");
    assert.equal(first.batch?.n, 3);
    assert.equal(first.batches[0].n, 3, "批次列表带持有天数");
    assert.equal(first.batches[1].offset, 1, "批次列表带换样本标记");

    const latest = await readFactorRuns(99);
    assert.equal(latest.batchIndex, 1, "越界回退到最新一批");
    assert.equal(latest.batch?.rows[0].factor, "new0");

    const def = await readFactorRuns();
    assert.equal(def.batchIndex, 1, "缺省 = 最新");
  });
});

test("坏行跳过并计数，不让一行坏数据废掉整份日志", async () => {
  await withTempDataDir(async (dir) => {
    const good = run();
    writeFileSync(
      join(dir, "backtest", "factor-runs.jsonl"),
      JSON.stringify(good) + "\n" + '{"factor":"半行","name":"写崩了' + "\n",
      "utf8",
    );
    const out = await readFactorRuns();
    assert.equal(out.badLines, 1);
    assert.equal(out.batch?.rows.length, 1, "好的那行要还在");
    assert.equal(out.batch?.rows[0].factor, "shrinkDays");
  });
});

test("诊断：三种 kind 分开取，flowProbe 按持有期各留最新", async () => {
  await withTempDataDir(async (dir) => {
    const lines = [
      JSON.stringify({ kind: "shrinkFlip", at: "2026-10-07T01:00:00.000Z", n: 10, segments: [{ from: "a", to: "b", days: 1, rollingSpread: 0.001, poolRet: -0.01 }] }),
      JSON.stringify({ kind: "shrinkFlip", at: "2026-10-07T02:00:00.000Z", n: 10, segments: [] }),
      JSON.stringify({ kind: "shrinkBull", at: "2026-10-07T02:00:00.000Z", n: 10, premiumT: -0.26 }),
      JSON.stringify({ kind: "flowProbe", at: "2026-10-07T02:00:00.000Z", n: 10, factors: [] }),
      JSON.stringify({ kind: "flowProbe", at: "2026-10-07T03:00:00.000Z", n: 5, factors: [] }),
      JSON.stringify({ kind: "flowProbe", at: "2026-10-07T04:00:00.000Z", n: 20, factors: [] }),
    ];
    writeFileSync(join(dir, "backtest", "factor-diag.jsonl"), lines.join("\n") + "\n", "utf8");

    const out = await readFactorDiag();
    assert.equal(out.shrinkFlip?.at, "2026-10-07T02:00:00.000Z", "shrinkFlip 取最新一条");
    assert.equal(out.shrinkBull?.premiumT, -0.26);
    // 按持有期升序，三个都有
    assert.deepEqual(
      out.flowProbe.map((r) => r.n),
      [5, 10, 20],
    );
  });
});

test("诊断：读不到时不编造，missing 要能当恢复指引用", async () => {
  await withTempDataDir(async () => {
    const out = await readFactorDiag();
    assert.equal(out.shrinkFlip, null);
    assert.deepEqual(out.flowProbe, []);
    assert.match(out.missing ?? "", /factor-diag\.jsonl/);
  });
});

test("基线：目录里有多个 baseline 时挑日期最新的那个", async () => {
  await withTempDataDir(async (dir) => {
    writeFileSync(join(dir, "backtest", "baseline-2026-10-06.txt"), "旧的", "utf8");
    writeFileSync(join(dir, "backtest", "baseline-2026-11-01.txt"), "新的", "utf8");

    const out = await readBaseline();
    assert.equal(out.name, "baseline-2026-11-01.txt");
    assert.equal(out.text, "新的");
  });
});

test("基线：一个都没有时 text 是 null 而不是空串", async () => {
  await withTempDataDir(async () => {
    const out = await readBaseline();
    assert.equal(out.text, null);
    assert.ok(out.missing);
  });
});
