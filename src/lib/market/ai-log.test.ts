/**
 * 这个文件是干什么的：
 * 钉住 AI 自我进化的三块纯逻辑——运行账本的读写/封顶、自我历史组装（prompt
 * 反馈段）、进化统计。
 *
 * 为什么值得钉：
 * 1. 自我历史是「提议 → 判决 → 回读下场 → 下一轮提议」闭环的焊缝：提议过的
 *    因子 id 在队列里找得到要报真实状态（过没过 6 关 / 淘汰 / 在验），找不到
 *    要说「没进队列」——报错了 AI 会在死胡同里反复提。
 * 2. 账本封顶 FIFO：写爆 500 条后丢最旧的，不能把新账丢掉。
 * 3. 统计数字全是直接计数（AI 来源的因子/挑战者），手工注册的不许混进来
 *    稀释转化率。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_LOG_CAP,
  readAILog,
  appendAILog,
  factorSelfHistory,
  strategySelfHistory,
  evolveStats,
  isAIChallenger,
  type AILogEntry,
} from "@/lib/market/ai-log";
import type { QueueEntry } from "@/lib/market/factor-queue";
import type { Challenger } from "@/lib/market/challenger";

function logEntry(partial: Partial<AILogEntry>): AILogEntry {
  return {
    at: "2026-10-09T10:00:00.000Z",
    layer: "factor",
    trigger: "manual",
    ok: true,
    proposed: [],
    rejected: [],
    ...partial,
  };
}

function queueEntry(partial: Partial<QueueEntry>): QueueEntry {
  return {
    id: "q_test",
    name: "测试因子",
    category: "波动率",
    direction: -1,
    expr: "std20 / amp20",
    rationale: "测试用的占位经济逻辑",
    source: "ai",
    status: "pending",
    failCount: 0,
    runs: 0,
    createdAt: "2026-10-09T00:00:00Z",
    lastRunAt: null,
    ...partial,
  };
}

function challenger(partial: Partial<Challenger>): Challenger {
  return {
    id: "c_test",
    style: "trend",
    name: "测试挑战者",
    status: "running",
    since: "2026-10-09",
    ...partial,
  };
}

// ── 读写 + 封顶 ─────────────────────────────────────────────────

test("账本读写往返；文件不存在返回空数组", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-log-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.deepEqual(await readAILog(), []);
    const e = logEntry({ proposed: [{ id: "q_a", name: "甲" }] });
    await appendAILog(e);
    assert.deepEqual(await readAILog(), [e]);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("账本写爆封顶后丢最旧的、留最新的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-log-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    for (let i = 0; i < AI_LOG_CAP + 10; i++) {
      await appendAILog(logEntry({ at: `2026-10-09T10:${String(i % 60).padStart(2, "0")}:00.000Z`, proposed: [{ id: `q_${i}`, name: `第${i}轮` }] }));
    }
    const entries = await readAILog();
    assert.equal(entries.length, AI_LOG_CAP);
    assert.equal(entries[0].proposed[0].id, "q_10");
    assert.equal(entries.at(-1)!.proposed[0].id, `q_${AI_LOG_CAP + 9}`);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 自我历史 ────────────────────────────────────────────────────

test("factorSelfHistory：提议的因子按队列现状报下场，找不到的明说没进队列", () => {
  const log = [
    logEntry({ at: "2026-10-07T10:00:00.000Z", proposed: [{ id: "q_pass", name: "过关因子" }, { id: "q_gone", name: "被拒因子" }] }),
    logEntry({ at: "2026-10-08T10:00:00.000Z", proposed: [{ id: "q_dead", name: "淘汰因子" }] }),
  ];
  const entries = [
    queueEntry({ id: "q_pass", status: "passed", runs: 1 }),
    queueEntry({ id: "q_dead", status: "tombstone", failCount: 2 }),
  ];
  const lines = factorSelfHistory(log, entries);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /过关因子.*已过 6 关/);
  assert.match(lines[0], /10-07 10:00/);
  assert.match(lines[1], /被拒因子.*没进队列/);
  assert.match(lines[2], /淘汰因子.*已淘汰/);
});

test("factorSelfHistory：自动触发的轮次带「自动」标记，只回最近 8 轮", () => {
  const log = Array.from({ length: 12 }, (_, i) =>
    logEntry({ at: `2026-10-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`, trigger: i % 2 === 0 ? "auto" : "manual", proposed: [{ id: `q_${i}`, name: `轮${i}` }] }),
  );
  const lines = factorSelfHistory(log, []);
  assert.equal(lines.length, 8);
  assert.match(lines[0], /轮4/);
  assert.ok(lines.filter((l) => l.includes("自动")).length > 0);
});

test("strategySelfHistory：提名按名单现状报下场", () => {
  const log = [
    logEntry({ layer: "strategy", proposed: [{ id: "c_promoted", name: "转正者" }, { id: "c_missed", name: "落选者" }] }),
  ];
  const chals = [challenger({ id: "c_promoted", status: "promoted" })];
  const lines = strategySelfHistory(log, chals);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /转正者.*已转正为冠军/);
  assert.match(lines[1], /落选者.*没进名单/);
});

// ── 统计 ────────────────────────────────────────────────────────

test("isAIChallenger：source 优先，老数据按 note 前缀认，手工注册不算", () => {
  assert.equal(isAIChallenger(challenger({ source: "ai" })), true);
  assert.equal(isAIChallenger(challenger({ note: "AI 提议：试试更快止盈" })), true);
  assert.equal(isAIChallenger(challenger({ source: "manual" })), false);
  assert.equal(isAIChallenger(challenger({})), false);
});

test("evolveStats：只数 AI 来源的产物，轮数按层分", () => {
  const log = [
    logEntry({ layer: "factor" }),
    logEntry({ layer: "factor", ok: false }),
    logEntry({ layer: "strategy" }),
  ];
  const entries = [
    queueEntry({ id: "q_ai_pass", source: "ai", status: "passed" }),
    queueEntry({ id: "q_ai_dead", source: "ai", status: "tombstone" }),
    queueEntry({ id: "q_ai_wait", source: "ai", status: "pending" }),
    queueEntry({ id: "q_manual", source: "manual", status: "passed" }),
  ];
  const chals = [
    challenger({ id: "c_ai_p", source: "ai", status: "promoted" }),
    challenger({ id: "c_ai_r", source: "ai", status: "rejected" }),
    challenger({ id: "c_ai_run", source: "ai", status: "running" }),
    challenger({ id: "c_man", status: "promoted" }),
  ];
  const stats = evolveStats(log, entries, chals);
  assert.deepEqual(stats, {
    factorRounds: 2,
    strategyRounds: 1,
    factorProposed: 3,
    factorPassed: 1,
    factorTombstoned: 1,
    chalNominated: 3,
    chalPromoted: 1,
    chalRejected: 1,
  });
});
