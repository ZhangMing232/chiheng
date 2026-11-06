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
 * 2. 一行一条，将来要用 grep/pandas 直接分析，不用先解析
 *
 * ⚠️ 2026-11-06 体检纠正：上面第 2 条原先写「写入频率低（只被拦时写），全量读
 * 完全可接受」，**已被实测推翻**——`record-journal.ts` 的提示闸标志在每分钟新起的
 * 进程里每次重置，同一句「交易日记录 N/60，样本还不够下结论」一天写 240 遍。
 * 实测 6721 行里唯一签名只有 621 条（9.2%），最重复的一条写了 249 次。
 * 去重/轮转属于待拍板的大件，见 design/REMAINING.md §12.2；本轮只改这段注释，
 * 不改任何行为。
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

/**
 * 同一条拦截的「身份」——去重键。
 *
 * 2026-11-06 拍板「只去重、不轮转」后落地。为什么是这五项：
 * - **tradingDate 必须在**：跨天同一句 reason 是两件事，合并掉就丢「哪天被拦」了。
 * - gate / style / reason：区分「哪套策略、被哪道闸、为什么」。
 * - candidates **只取股票 id 集合，不取整块对象**：候选名单是「本来想买什么」的
 *   证据，整个丢掉会让这份日志失去存在意义；但里面的 buy/score 是行情价，
 *   每分钟都在动，整块塞进键会把同一天同一理由撑成上百种「不同」记录
 *   （实测 2026-10-09 一天就有 159 种），等于没去重。
 *
 * 三种口径的实测压缩比（6789 行）：不含 candidates → 51 行（0.75%，丢证据）、
 * 含候选 id → **222 行（3.27%，采用）**、含完整 candidates → 621 行（9.15%，白留噪声）。
 */
export function gateDedupeKey(block: GateBlock): string {
  const ids = (block.candidates ?? []).map((c) => c.id).sort().join(",");
  return JSON.stringify([block.tradingDate, block.gate, block.style, block.reason, ids]);
}

/**
 * 写一条拦截记录；**同一交易日内的同一条只写一次**（保留首次）。
 *
 * 为什么要在这里去重，而不是在 record-journal 的调用点：那份脚本每分钟新起一个
 * 进程，`buysPresentThisRun` 这类进程内标志每次都重置，正是「一天 240 行同一句」
 * 的根因（见 design/REMAINING.md §12.2）。判据必须落在磁盘上。
 *
 * 读全量再过滤当天：文件压缩后稳定在几百行，开销可忽略；压缩前 1.6 MB /
 * 六千多行解析一次约几十毫秒，每分钟一次也在可接受范围。
 *
 * ⚠️ 并发：两个进程同时写同一签名可能各写一行。记账只有一个 launchd 进程在跑，
 * 且日志重复不毁数据，所以不引入锁；真出现并发重复，下一轮也不会再追加。
 */
export function appendGateLog(block: GateBlock): void {
  try {
    const path = logPath();
    let needsNewline = false;
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const key = gateDedupeKey(block);
      for (const line of raw.split("\n")) {
        const text = line.trim();
        if (!text) continue;
        try {
          const prev = JSON.parse(text) as GateBlock;
          // 只比当天：文件按时间追加，跨天直接跳过省解析。
          if (prev.tradingDate === block.tradingDate && gateDedupeKey(prev) === key) return;
        } catch {
          // 崩溃时写了一半的坏行，跳过（readGateLogs 同一取舍）。
        }
      }
      // 崩溃可能留下一条**没有换行结尾**的半行；直接 append 会把新行粘在它后面，
      // 两条一起变坏数据（去重测试抓到过）。先补换行，坏行原样留着当证据。
      needsNewline = raw.length > 0 && !raw.endsWith("\n");
    }
    appendFileSync(path, `${needsNewline ? "\n" : ""}${JSON.stringify(block)}\n`, "utf8");
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
