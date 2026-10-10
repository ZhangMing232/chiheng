/**
 * 这个文件是干什么的：
 * 决策者记分牌——同一个问题用记账回答：**AI 做的决策到底赚不赚钱？**
 *
 * 学 deepseek-harness-quant 的五池远期验证：AI 选 / 机器选 / 人选 / 牛散选分组
 * 跑 forward，用真实收益裁决「AI 行不行」，不辩论。赤轨的决策只有两个来源
 * （AI 提议 / 人工登记），但判决产物本来就是分开记的，这里把它们聚合成一张
 * 对照表：
 *
 *   因子层：queue 里 source=ai 的提议，过了几个 / 淘汰了几个 / 还活着几个
 *   策略层：challengers.json 里 source=ai 的提名，转正 / 淘汰 / 未决各几个
 *   死因：factor-tombstones.jsonl 里按 source 数（含衰减退役）
 *
 * 你需要知道的：
 * 1. 只读聚合，不改任何文件。数据缺哪边就空哪边，不补 0 冒充（0 个 AI 提议
 *    和「读不到」是两回事——前者是真没有，后者是账坏了）。
 * 2. 纯函数 buildLedger 吃解析好的数据，测试直接喂构造的队列/挑战者/档案；
 *    文件读取在最外层。
 * 3. 「赚钱」在因子层不是收益而是过关率——6 关过关 = 这个假设经得起数据裁决；
 *    收益层面的对照由六套策略账本和挑战者判决承担。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueEntry } from "./factor-queue.ts";
import type { Challenger } from "./challenger.ts";
import type { TombstoneRecord } from "./factor-tombstones.ts";

export type DecisionMaker = "ai" | "manual";

export type FactorLedger = {
  /** 提议总数。 */
  proposed: number;
  /** 已过 6 关（含在监控中的）。 */
  passed: number;
  /** 待验 / 检验中。 */
  pending: number;
  /** 已淘汰（含衰减退役）。 */
  dead: number;
};

export type ChallengerLedger = {
  /** 提名总数。 */
  proposed: number;
  running: number;
  promoted: number;
  rejected: number;
  inconclusive: number;
};

export type DecisionLedger = {
  factors: Record<DecisionMaker, FactorLedger>;
  challengers: Record<DecisionMaker, ChallengerLedger>;
  /** 死因档案里按来源计的死亡总数（含衰减退役；档案 2026-10-10 才开始记）。 */
  tombstones: Record<DecisionMaker, number>;
};

const emptyFactorLedger = (): FactorLedger => ({ proposed: 0, passed: 0, pending: 0, dead: 0 });
const emptyChallengerLedger = (): ChallengerLedger => ({ proposed: 0, running: 0, promoted: 0, rejected: 0, inconclusive: 0 });

/** 纯函数：三类产物 → 记分牌。 */
export function buildLedger(input: {
  queue: QueueEntry[];
  challengers: Challenger[];
  tombstones: TombstoneRecord[];
}): DecisionLedger {
  const factors: Record<DecisionMaker, FactorLedger> = { ai: emptyFactorLedger(), manual: emptyFactorLedger() };
  for (const e of input.queue) {
    const L = factors[e.source];
    L.proposed += 1;
    if (e.status === "passed" || e.status === "monitoring") L.passed += 1;
    else if (e.status === "tombstone" || e.status === "decayed") L.dead += 1;
    else L.pending += 1;
  }
  const challengers: Record<DecisionMaker, ChallengerLedger> = { ai: emptyChallengerLedger(), manual: emptyChallengerLedger() };
  for (const c of input.challengers) {
    const L = challengers[c.source ?? "manual"];
    L.proposed += 1;
    if (c.status === "running") L.running += 1;
    else if (c.status === "promoted") L.promoted += 1;
    else if (c.status === "rejected") L.rejected += 1;
    else L.inconclusive += 1;
  }
  const tombstones: Record<DecisionMaker, number> = { ai: 0, manual: 0 };
  for (const t of input.tombstones) tombstones[t.source] += 1;
  return { factors, challengers, tombstones };
}

// ── 文件读取（node:fs，server-only）────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dataDir(), name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 读记分牌。任何一个文件读不到都按空处理——聚合不该因为一个文件坏而炸。 */
export async function readDecisionLedger(): Promise<DecisionLedger> {
  const queue = await readJson<{ entries?: QueueEntry[] }>("factor-queue.json", { entries: [] });
  const challengers = await readJson<{ list?: Challenger[] }>("challengers.json", { list: [] });
  let tombstones: TombstoneRecord[] = [];
  try {
    const raw = await readFile(join(dataDir(), "backtest", "factor-tombstones.jsonl"), "utf8");
    tombstones = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TombstoneRecord);
  } catch {
    // 档案还没开始记（2026-10-10 才有）——按空。
  }
  return buildLedger({
    queue: Array.isArray(queue.entries) ? queue.entries : [],
    challengers: Array.isArray(challengers.list) ? challengers.list : [],
    tombstones,
  });
}
