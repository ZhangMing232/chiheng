/**
 * 这个文件是干什么的：
 * 记「风控本来要拦下什么」。硬闸或提示闸不通过时调 appendGateLog。
 *
 * 为什么必须记：
 * 被拦之后如果不留痕，事后只知道「今天没开仓」，看不出是风控拦的、拦的是哪套、
 * 拦的时候本来有哪些票在名单上。没有这些就没法回答两个问题：
 *   「风控到底有没有用」——要证据，不是感觉
 *   「如果不拦会怎么样」——这是唯一能验证闸门合理性的办法
 *
 * 为什么用 JSONL 追加而不是 JSON 文件：
 * 1. 追加天然幂等，写到一半崩了不会毁掉已有行（book-file.ts:71-73 那个坑：
 *    「坏文件会被 readUserBook 当成没有账而整本消失」——那是整本账的量级，
 *    风控日志虽然小得多，但同样的道理：日志不该有能力毁掉历史）
 * 2. 写入频率低（只被拦时写），全量读完全可接受
 * 3. 一行一条，将来要用 grep/pandas 直接分析，不用先解析
 *
 * 这不是账本。账本错了会算错收益率；这份日志错了只会误导事后复盘，
 * 所以它绝不参与任何计算。
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StyleId } from "./strategies.ts";

export type GateKind = "hard" | "soft";

export type GateBlock = {
  /** 毫秒时间戳 */
  at: number;
  /** 上海日期，这个才是「哪一天」，at 是机器时间 */
  tradingDate: string;
  style: StyleId;
  gate: GateKind;
  /** 闸门给的原话，直接给界面/日志用，不要另编一套说法 */
  reason: string;
  /**
   * 关键：本来想买什么。不记这个的话，事后只知道「今天没开仓」，
   * 不知道风控拦的是一批什么样的票——也就没法判断闸门是不是拦过头了。
   */
  candidates: { id: string; name: string; buy: number; score: number }[];
};

/**
 * 快照过期这类不是策略问题的拦截也走这里，gate 标 "soft"，reason 写清原因。
 *
 * 目录默认是项目下的 data/，和账本、缓存放在一起（都不在 git 里）。
 * CHIHENG_DATA_DIR 可以改它——测试要写到临时目录去，
 * 往真的 data/ 里写测试数据会污染唯一的账本。
 */
function logPath(): string {
  const dir = process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
  return join(dir, "gate-blocks.jsonl");
}

export function appendGateLog(block: GateBlock): void {
  try {
    appendFileSync(logPath(), `${JSON.stringify(block)}\n`, "utf8");
  } catch (err) {
    // 写不进去不能拖垮记账——风控日志是「证据」，不是「闸门」本身。
    // 闸门的判断已经在调用方做完了，这里挂了只影响事后复盘。
    console.warn(`[gate-log] 写不进去：${(err as Error).message}`);
  }
}

export function readGateLogs(): GateBlock[] {
  const path = logPath();
  if (!existsSync(path)) return [];
  const out: GateBlock[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text) as GateBlock);
    } catch {
      // 崩溃时写了一半的那行。跳过，别让一行坏数据把整份日志废掉。
    }
  }
  return out;
}

/** 某个交易日内被硬闸拦下的次数。实验台拿它证明「风控真的生效过」。 */
export function hardBlocksOn(date: string): GateBlock[] {
  return readGateLogs().filter((block) => block.gate === "hard" && block.tradingDate === date);
}
