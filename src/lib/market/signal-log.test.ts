/**
 * signal-log.ts 的守门测试。
 *
 * 钉的东西：
 *   1. 同一天同一 style 同一只票只记一行（stamp 去重）——候选集合是并集，
 *      不是每分钟一份；重复记会把「候选数」这个分母灌水
 *   2. 读：文件不在 = 「还没记过」（带原因），不是「0 条信号」；
 *      坏行跳过且计数——一行坏数据不该废掉整份日志
 *   3. dedupSignals：stamp 写失败造成的重复行，按 (date,style,id) 留第一条
 *   4. fillOf：按 (signal 日期, style, id) 和账本对；同 id 不同 style 不算成交
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSignals,
  dedupSignals,
  fillOf,
  readSignals,
  type SignalRecord,
} from "@/lib/market/signal-log";

const DATE = "2026-10-23";

function cand(id: string, over: Partial<{ score: number; buy: number; hit: boolean; block: "limit" | "away" }> = {}) {
  return { id, code: id.replace(/[a-z]/g, "").padStart(6, "0"), name: `票${id}`, score: 10, buy: 10, hit: false, ...over };
}

async function withDataDir(fn: () => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "signal-log-test-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await mkdir(dir, { recursive: true });
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("追加 + 读回：字段一个不少", async () => {
  await withDataDir(async () => {
    const n = appendSignals(DATE, "rebound", [cand("sh600001", { hit: true })], 1234);
    assert.equal(n, 1);
    const { rows, badLines, missing } = readSignals();
    assert.equal(missing, null);
    assert.equal(badLines, 0);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      at: 1234,
      tradingDate: DATE,
      style: "rebound",
      id: "sh600001",
      code: "600001",
      name: "票sh600001",
      score: 10,
      buy: 10,
      hit: true,
      block: null,
    } satisfies SignalRecord);
  });
});

test("同一天同 style 同票再追加 = 0 行（候选是并集不是每分钟一份）", async () => {
  await withDataDir(async () => {
    assert.equal(appendSignals(DATE, "rebound", [cand("sh600001")], 1), 1);
    assert.equal(appendSignals(DATE, "rebound", [cand("sh600001")], 2), 0, "已记过的不重复记");
    // 名单换了一只：只追加新的那只
    assert.equal(appendSignals(DATE, "rebound", [cand("sh600001"), cand("sh600002")], 3), 1);
    const { rows } = readSignals();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].at, 1, "留第一次出现的时刻");
    assert.equal(rows[1].id, "sh600002");
  });
});

test("stamp 按 style 分开：同一只票两套策略各记一行", async () => {
  await withDataDir(async () => {
    appendSignals(DATE, "breakout", [cand("sh600001")], 1);
    appendSignals(DATE, "rebound", [cand("sh600001")], 2);
    const { rows } = readSignals();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.style), ["breakout", "rebound"]);
  });
});

test("空候选不建文件", async () => {
  await withDataDir(async () => {
    assert.equal(appendSignals(DATE, "breakout", [], 1), 0);
    const { missing } = readSignals();
    assert.ok(missing !== null, "没记过要带原因，不是 0 条");
  });
});

test("读：文件不在 = 还没记过，不是「0 条信号」", async () => {
  await withDataDir(async () => {
    const { rows, missing } = readSignals();
    assert.equal(rows.length, 0);
    assert.ok(missing?.includes("signals.jsonl"), `原因要点名文件，实际：${missing}`);
  });
});

test("读：坏行跳过且计数，不废掉整份日志", async () => {
  await withDataDir(async () => {
    appendSignals(DATE, "rebound", [cand("sh600001")], 1);
    const path = join(process.env.CHIHENG_DATA_DIR!, "signals.jsonl");
    await (await import("node:fs/promises")).appendFile(path, '{"at":2,"tradingDate":"2026-10-23"\n');
    const { rows, badLines } = readSignals();
    assert.equal(rows.length, 1, "好行还在");
    assert.equal(badLines, 1, "坏行要计数");
  });
});

test("dedupSignals：stamp 写失败造成的重复行，按 (date,style,id) 留第一条", async () => {
  await withDataDir(async () => {
    appendSignals(DATE, "rebound", [cand("sh600001")], 1);
    // 模拟 stamp 丢失后重复追加（直接往日志里再写一行同 key）
    const path = join(process.env.CHIHENG_DATA_DIR!, "signals.jsonl");
    await (await import("node:fs/promises")).appendFile(
      path,
      JSON.stringify({ at: 9, tradingDate: DATE, style: "rebound", id: "sh600001", code: "600001", name: "票", score: 10, buy: 10, hit: false, block: null }) + "\n",
    );
    const { rows } = readSignals();
    assert.equal(rows.length, 2, "存储层确实有重复");
    const deduped = dedupSignals(rows);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].at, 1, "留第一条（第一次出现）");
  });
});

test("fillOf：按 (signal 日期, style, id) 对账本；对不上就是没成交", async () => {
  const signal: SignalRecord = {
    at: 1, tradingDate: DATE, style: "rebound", id: "sh600001", code: "600001", name: "票", score: 10, buy: 10, hit: false, block: null,
  };
  const book = [
    { date: DATE, trades: [{ id: "sh600001", style: "breakout", entry: 10, exit: null }] },
    { date: "2026-10-22", trades: [{ id: "sh600001", style: "rebound", entry: 10, exit: 11 }] },
  ];
  assert.equal(fillOf(signal, book), null, "同 id 但 style 不同不算成交");
  const book2 = [{ date: DATE, trades: [{ id: "sh600001", style: "rebound", entry: 10.5, exit: null }] }];
  assert.deepEqual(fillOf(signal, book2), { entry: 10.5, exit: null });
  const book3 = [{ date: "2026-10-24", trades: [{ id: "sh600001", style: "rebound", entry: 10.5, exit: 11 }] }];
  assert.equal(fillOf(signal, book3), null, "日期不同不算");
});

test("block 原样记：away/limit 是选择偏差的两种死法", async () => {
  await withDataDir(async () => {
    appendSignals(DATE, "rebound", [cand("sh600001", { block: "away" }), cand("sh600002", { block: "limit" }), cand("sh600003")], 1);
    const { rows } = readSignals();
    assert.deepEqual(rows.map((r) => r.block), ["away", "limit", null]);
  });
});
