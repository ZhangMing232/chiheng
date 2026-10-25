/**
 * 这个文件是干什么的：
 * 记「每天选股名单上出现过谁」——**包括没成交的**。
 *
 * 为什么必须记（这是选择偏差那块）：
 * 账本里只有「现价打到买入价」才落账。于是所有绩效统计的样本都自带一个
 * 条件：价格找上门来。信号发出去而价格跑飞的（block=away）、涨停买不进
 * 的（block=limit），在账本里完全不存在——想量「成交是不是系统性地偏
 * 向某类信号」就没有分母。这份日志补上分母：观察名单前 10 只，每天第一
 * 次出现就记一行，成不成交另说（成不成看账本，两边用 id 对）。
 *
 * 记的粒度：每套策略每天、观察名单前 10 只里**第一次出现**的那一行。
 * 不是每分钟都记——名单每分钟随行情重算，一只票可能 09:35 不在前 10、
 * 10:00 才进来，要的是当天候选集合的并集；同一天同一只票重复出现不重
 * 复记（stamp 去重）。hit/block 记的是第一次出现那一刻的状态，是快照
 * 属性，别当成全天属性读。
 *
 * 和 gate-blocks.jsonl 的分工：那个记「闸门拦下了什么」（风控视角），
 * 这个记「策略选了谁、谁没成交」（选股视角）。同一个候选可能两边都有，
 * 各自回答不同的问题。
 *
 * 这不是账本：日志错了只会误导复盘，**绝不参与任何计算**（gate-log.ts 同款声明）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StyleId } from "./strategies.ts";

export type SignalRecord = {
  /** 毫秒时间戳：第一次在名单里看到的时刻 */
  at: number;
  /** 上海日期——「哪一天」看这个，at 是机器时间 */
  tradingDate: string;
  style: StyleId;
  id: string;
  code: string;
  name: string;
  score: number;
  /** 计划买入价：现价打到它才成交的那个价 */
  buy: number;
  /** 那一刻现价是否已到买入价 */
  hit: boolean;
  /** 买不进的原因；null = 按买入价可成交 */
  block: "limit" | "away" | null;
};

/** appendSignals 的入参：调用方（record-journal）手里那行的最小形状。 */
export type SignalCandidate = {
  id: string;
  code: string;
  name: string;
  score: number;
  buy: number;
  hit: boolean;
  block?: "limit" | "away";
};

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

function logPath(): string {
  return join(dataDir(), "signals.jsonl");
}

/**
 * 按日去重的 stamp：{ "breakout": ["sh600000", ...], ... }。
 * 写在追加成功之后——写失败了下一分钟再试，顶多重复记（读的时候按
 * (tradingDate, style, id) 保留第一条），总比漏记强。
 */
function stampPath(date: string): string {
  return join(dataDir(), `.signals-${date}.json`);
}

function readStamp(date: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(date), "utf8")) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [style, ids] of Object.entries(parsed)) {
      if (Array.isArray(ids)) out[style] = ids.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    // 没有 stamp（当天第一次）或坏了：当空的，重新记一遍（读侧去重兜底）
    return {};
  }
}

/**
 * 追加一批候选。同一天同一 style 下已记过的 id 跳过。
 * 同步 + 内部 try/catch：写不进去只警告，不能拖垮记账（gate-log.ts 同款理由）。
 */
export function appendSignals(date: string, style: StyleId, rows: SignalCandidate[], at = Date.now()): number {
  if (rows.length === 0) return 0;
  try {
    const seen = readStamp(date);
    const known = new Set(seen[style] ?? []);
    const fresh = rows.filter((row) => !known.has(row.id));
    if (fresh.length === 0) return 0;
    const lines = fresh
      .map((row) =>
        JSON.stringify({
          at,
          tradingDate: date,
          style,
          id: row.id,
          code: row.code,
          name: row.name,
          score: row.score,
          buy: row.buy,
          hit: row.hit,
          block: row.block ?? null,
        } satisfies SignalRecord),
      )
      .join("\n");
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(logPath(), `${lines}\n`, "utf8");
    seen[style] = [...known, ...fresh.map((row) => row.id)];
    writeFileSync(stampPath(date), JSON.stringify(seen), "utf8");
    return fresh.length;
  } catch (err) {
    console.warn(`[signal-log] 写不进去：${(err as Error).message}`);
    return 0;
  }
}

export type SignalLogRead = {
  rows: SignalRecord[];
  /** 崩现场写了一半的坏行数。跳过不计，但报出来——坏行多说明存储有问题 */
  badLines: number;
  /** 文件不存在时的原因。null = 文件在读到了（哪怕 0 行） */
  missing: string | null;
};

/** 读全量。文件不在返回带原因的的空结构——「还没记过」不是「0 条信号」。 */
export function readSignals(): SignalLogRead {
  const path = logPath();
  if (!existsSync(path)) return { rows: [], badLines: 0, missing: "signals.jsonl 还不存在（没记过信号）" };
  const rows: SignalRecord[] = [];
  let badLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text) as SignalRecord);
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines, missing: null };
}

/** 按 (tradingDate, style, id) 保留第一条。stamp 写失败会造成重复行，分析前先过这个。 */
export function dedupSignals(rows: SignalRecord[]): SignalRecord[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.tradingDate}|${row.style}|${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 信号有没有成交：和账本按 (signal 那天的日期, style, id) 对。
 * 对得上返回那笔的进出场价，对不上 null——null 就是「选了没成交」的那个。
 * 纯函数：账本由调用方给，这里不碰文件。
 */
export function fillOf(
  signal: SignalRecord,
  trades: { date?: string; trades: { id: string; style?: string; entry: number; exit: number | null }[] }[],
): { entry: number; exit: number | null } | null {
  for (const day of trades) {
    if (day.date !== signal.tradingDate) continue;
    for (const trade of day.trades) {
      if (trade.id === signal.id && trade.style === signal.style) {
        return { entry: trade.entry, exit: trade.exit };
      }
    }
  }
  return null;
}
