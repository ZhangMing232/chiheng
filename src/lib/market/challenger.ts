/**
 * 这个文件是干什么：
 * 冠军-挑战者框架。冠军 = 策略当前参数；挑战者 = 同一份选股名单、不同的出场参数
 * （持有天数/止损/目标价），每天限 1 只和冠军并行跑纸面。攒够样本后按预先登记的
 * 标准自动判决：显著更好 → 转正为冠军；自己质量不过关 → 淘汰；跑满上限仍分不出
 * →  inconclusive 停跑。冠军被策略闸停用时，自动回滚到默认参数。
 *
 * 你需要知道的：
 * 判决标准在 CHALLENGER_RULE 预先登记。挑战者只改出场参数、不改选股——
 * 选股名单的一致性保证了「收益差异来自参数」这个归因成立。
 * 所有状态在 data/ 下：challengers.json（在跑的挑战者）、champions.json
 * （每套策略当前用哪份参数）、champion-log.jsonl（每次切换/回滚的留档）。
 * 注册挑战者 = 编辑 data/challengers.json（见 README「策略进化」）。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tStat } from "./strategy-gate.ts";
import { dayReliable, netReturn } from "./journal-book.ts";
import { styleOf } from "./strategies.ts";

/** 预先登记的挑战者判决标准。改这里等于改规则本身，要带着理由改。 */
export const CHALLENGER_RULE = {
  /** 双方各攒够多少笔已平仓才判决。 */
  minTrades: 30,
  /** Welch t ≥ 1.5 且挑战者均值更高 → 转正。 */
  promoteT: 1.5,
  /** 挑战者自己的 t ≤ −2 → 质量不过关，淘汰。 */
  rejectT: -2,
  /** 跑满这么多笔还分不出胜负 →  inconclusive 停跑，不再占用样本。 */
  maxTrades: 200,
} as const;

export type Challenger = {
  id: string;
  /** 挑战哪套策略（StyleId）。 */
  style: string;
  name: string;
  note?: string;
  /** 以下三个参数缺省的沿用冠军值。 */
  holdDays?: number;
  stopPct?: number;
  targetPct?: number;
  status: "running" | "promoted" | "rejected" | "inconclusive";
  /** 开跑的交易日。 */
  since: string;
  /** 谁提的。AI 提名的带 "ai"（自我进化统计用）；人工注册的不写。 */
  source?: "ai" | "manual";
};

export type ChallengersFile = { list: Challenger[] };
/** 每套策略当前生效的参数版本。"champion" = 代码里的默认参数。 */
export type ChampionsFile = Record<string, string>;

const dataDir = () => process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
export const challengersPath = () => join(dataDir(), "challengers.json");
export const championsPath = () => join(dataDir(), "champions.json");
export const championLogPath = () => join(dataDir(), "champion-log.jsonl");

export async function readChallengers(): Promise<ChallengersFile> {
  try {
    const parsed = JSON.parse(await readFile(challengersPath(), "utf8"));
    if (parsed && Array.isArray(parsed.list)) return parsed as ChallengersFile;
  } catch {
    // 没有文件 = 没有挑战者，正常。
  }
  return { list: [] };
}

export async function writeChallengers(file: ChallengersFile) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(challengersPath(), JSON.stringify(file, null, 2));
}

export async function readChampions(): Promise<ChampionsFile> {
  try {
    const parsed = JSON.parse(await readFile(championsPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ChampionsFile;
  } catch {
    // 没有文件 = 全部用默认参数，正常。
  }
  return {};
}

export async function writeChampions(file: ChampionsFile) {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(championsPath(), JSON.stringify(file, null, 2));
}

/** 每次参数切换/回滚追加一行留档。回滚靠它知道上一任是谁。 */
export async function appendChampionLog(entry: { at: number; style: string; from: string; to: string; reason: string }) {
  await mkdir(dataDir(), { recursive: true });
  await appendFile(championLogPath(), JSON.stringify(entry) + "\n");
}

/**
 * Welch 双样本 t：均值差的标准误用两组各自的方差（不要求等方差）。
 * 返回 mean(a) − mean(b) 的 t 值；任一组少于 2 笔返回 null。
 */
export function welchT(a: number[], b: number[]): number | null {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return null;
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const variance = (xs: number[]) => {
    const m = mean(xs);
    return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const se = Math.sqrt(variance(a) / na + variance(b) / nb);
  if (!(se > 0)) return null;
  return (mean(a) - mean(b)) / se;
}

const meanOf = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

/**
 * 从账本日数据按 `style:variant` 分桶已平仓净收益。判决（record-journal）和
 * UI 上的「样本 x/30」进度共用这一个口径——两边各写一遍分桶逻辑，数字就会
 * 对不上。只数信号日可信的天、已平仓、风格可识别、净收益算得出来的单。
 */
export function bucketReturns(
  days: { signalTime?: string; trades: { entry?: number; exit?: number | null; style?: string; variant?: string }[] }[],
): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const day of days) {
    if (!dayReliable(day)) continue;
    for (const trade of day.trades) {
      if (trade.exit == null || typeof trade.entry !== "number") continue;
      const style = styleOf(trade);
      if (!style) continue;
      const ret = netReturn(trade.entry, trade.exit);
      if (ret == null) continue;
      const key = `${style}:${trade.variant && trade.variant !== "champion" ? trade.variant : "champion"}`;
      const list = buckets.get(key) ?? [];
      list.push(ret);
      buckets.set(key, list);
    }
  }
  return buckets;
}

export type ChallengerDecision =
  | { action: "promote"; reason: string }
  | { action: "reject"; reason: string }
  | { action: "inconclusive"; reason: string }
  | { action: "none"; reason: string };

/**
 * 判决一个挑战者。champ = 冠军同期逐笔净收益，chal = 挑战者逐笔净收益，
 * 都要按平仓日排好序、只数信号日可信的天（调用方负责过滤）。
 */
export function judgeChallenger(champ: number[], chal: number[]): ChallengerDecision {
  if (chal.length < CHALLENGER_RULE.minTrades || champ.length < CHALLENGER_RULE.minTrades) {
    return { action: "none", reason: "" };
  }
  const ownT = tStat(chal.slice(-CHALLENGER_RULE.maxTrades));
  if (ownT != null && ownT <= CHALLENGER_RULE.rejectT) {
    return {
      action: "reject",
      reason: `挑战者自身质量不过关：最近 ${chal.length} 笔 t=${ownT.toFixed(2)} ≤ ${CHALLENGER_RULE.rejectT}，淘汰`,
    };
  }
  const t = welchT(chal, champ);
  if (t != null && t >= CHALLENGER_RULE.promoteT && meanOf(chal) > meanOf(champ)) {
    return {
      action: "promote",
      reason: `显著更好：挑战者 ${chal.length} 笔均值 ${(meanOf(chal) * 100).toFixed(2)}% vs 冠军 ${champ.length} 笔 ${(meanOf(champ) * 100).toFixed(2)}%，t=${t.toFixed(2)} ≥ ${CHALLENGER_RULE.promoteT}，转正`,
    };
  }
  if (chal.length >= CHALLENGER_RULE.maxTrades) {
    return { action: "inconclusive", reason: `跑满 ${CHALLENGER_RULE.maxTrades} 笔仍分不出胜负，停跑不再占样本` };
  }
  return { action: "none", reason: "" };
}
