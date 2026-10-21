/**
 * 这个文件是干什么的：
 * 读因子研究的两份本地产物——data/backtest/factor-runs.jsonl（每个因子一条的 6 关
 * 判决）和 factor-diag.jsonl（缩量天数归因、止跌溢价、资金流探路），外加结论文本
 * baseline-*.txt。只读，不写。
 *
 * 你需要知道的：
 * 1. 写的人是 scripts/backtest.ts（BT_FACTOR / BT_DIAG / BT_FLOW 那三个分支）。
 *    这个文件只负责把它读出来给页面，两边字段名必须一字对应，改名要一起改。
 * 2. **data/ 在 .gitignore 里**，线上和新机器上必然读不到。所以读不到要返回带 why
 *    的空结构，让页面说「还没跑」，绝不能返回空数组冒充「0 个因子」——本项目的
 *    第一条规矩：拿不到 ≠ 没有。
 * 3. CHIHENG_DATA_DIR 可以把数据目录换到临时目录（测试靠它），别往真 data/ 里写。
 *    和 gate-log.ts 同一个约定。
 * 4. 批次怎么分：同一次跑的 25 条，at 时间戳相差几毫秒（实测 .500Z / .501Z），
 *    用字符串严格相等会把一批劈成两半；只截到秒又会在跨秒边界丢行。所以用
 *    5 秒容差聚类，见 clusterByBatch。
 * 5. jsonl 坏行跳过并计数，不能让一行坏数据废掉整份日志（gate-log.ts 同一取舍）。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** 一次因子检验里，单个因子的结果（factor-runs.jsonl 的一行）。 */
export type FactorRunRow = {
  at: string;
  factor: string;
  name: string;
  direction: 1 | -1;
  /** 持有天数 */
  n: number;
  buckets: number;
  offset: number;
  nDays: number;
  /** 最高档减最低档的平均超额 */
  meanSpread: number;
  t: number;
  topBlockedRatio: number;
  /** 从因子值最低档到最高档，各档平均超额 */
  bucketMeans: number[];
  resampleSpread: number;
  resampleT: number;
  /**
   * 前后两段各自的 [前 spread, 后 spread]。G3（两段同号）的判据原话要用。
   * **旧批次没有这两个字段**（2026-10-07 之前跑的）——页面遇到必须显示「没记」，
   * 不能编一个数字出来。
   */
  halfSpread?: number[];
  halfT?: number[];
  /** 每关的判据原话，如「|t|= 4.35 vs 临界 3.09（N=25）」。旧批次没有。 */
  gateDetails?: Partial<Record<GateKey, string>>;
  gates: Partial<Record<GateKey, boolean>>;
  /** Bonferroni 用的「已测因子总数」 */
  nTested: number;
  /** 回测抽样的股票池规模（如 296/500）。**旧批次没有**——读不到显示「没记」，不能编。 */
  universe?: number;
  /** spread 序列的偏度/峰度，DSR（运气线校正）的输入。**旧批次没有**——读不到显示「没记」。 */
  spreadSkew?: number | null;
  spreadKurt?: number | null;
  /**
   * 运气线校正：本轮共试 nTrials 个因子时，运气最好那个的显著性基准线。
   * survives=true 表示该因子的 per-period 夏普高过这条线，不像纯搜出来的。
   * **只存档展示，不进 6 关判决**（判决规则改动必须用户拍板）。**旧批次没有**。
   */
  dsr?: { value: number; expectedMax: number; survives: boolean; nTrials: number } | null;
};

export type GateKey = "g1" | "g2" | "g3" | "g4" | "g5" | "g6";

/** 缩量天数归因：翻号是零散的几段，不是一整段。 */
export type ShrinkFlipDiag = {
  kind: "shrinkFlip";
  at: string;
  n: number;
  buckets: number;
  nTested: number;
  nDays: number;
  /** shrinkDays 与 d60 的横截面 Spearman 均值。|ρ| 越低越不像同一个信号。 */
  corrAll: number;
  corrSeg: number[];
  spreadSeg: number[];
  /** d60 中性化后 shrinkDays 的独立值 */
  neutSpread: number;
  neutT: number;
  neutDays: number;
  rollingWindow: number;
  segments: { from: string; to: string; days: number; rollingSpread: number; poolRet: number }[];
};

/** 缩量 + 止跌复合：顶档里「当日收涨」和「不涨」两半各是什么样。 */
export type ShrinkBullDiag = {
  kind: "shrinkBull";
  at: string;
  n: number;
  buckets: number;
  bullMean: number;
  bullDays: number;
  bearMean: number;
  bearDays: number;
  /** 止跌 - 不止跌 */
  premiumMean: number;
  premiumT: number;
  premiumDays: number;
  flipSegments: { from: string; to: string; days: number; bull: number | null; bear: number | null }[];
};

/** 资金流探路：每个持有期一条。G4 换样本这次没做，所以只有 5 关。 */
export type FlowProbeDiag = {
  kind: "flowProbe";
  at: string;
  n: number;
  buckets: number;
  effectiveDays: number;
  cacheHit: number;
  cacheTotal: number;
  factors: {
    id: string;
    name: string;
    direction: 1 | -1;
    spread: number;
    t: number;
    nDays: number;
    topBlockedRatio: number;
    bucketMeans: number[];
    gates: Partial<Record<GateKey, boolean>>;
    gateDetails: Partial<Record<GateKey, string>>;
    neutSpread: number;
    neutT: number;
    neutDays: number;
  }[];
};

export type DiagRow = ShrinkFlipDiag | ShrinkBullDiag | FlowProbeDiag;

export type FactorRunsPayload = {
  batch: {
    at: string;
    n: number;
    buckets: number;
    nDays: number;
    nTested: number;
    rows: FactorRunRow[];
  } | null;
  /** 日志里有几批、各多少条——页面要说清「现在看的是哪一批」。
   *  带 n（持有天数）/offset（换样本）/buckets，让选择器能标出「这批是什么参数跑的」。 */
  batches: { at: string; count: number; n: number; offset: number; buckets: number }[];
  /** 当前返回的是第几批（0 起 = 最旧）。默认取最新一批。 */
  batchIndex: number;
  badLines: number;
  /** 读不到的原因（能当恢复指引用）。null 表示读到了。 */
  missing: string | null;
};

export type FactorDiagPayload = {
  shrinkFlip: ShrinkFlipDiag | null;
  shrinkBull: ShrinkBullDiag | null;
  /** 按持有期升序；同一持有期只留最新一条 */
  flowProbe: FlowProbeDiag[];
  badLines: number;
  missing: string | null;
};

export type FactorBaselinePayload = {
  name: string | null;
  text: string | null;
  bytes: number;
  missing: string | null;
};

function backtestDir(): string {
  return join(process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data"), "backtest");
}

/** JSONL → 对象数组，坏行跳过并计数。 */
function parseLines<T>(text: string): { rows: T[]; badLines: number } {
  const rows: T[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

/**
 * 把同一批次的行聚到一起。
 *
 * 为什么不能简单分组：同一次跑的 25 条，at 是逐条 `new Date().toISOString()`，
 * 相差几毫秒（实测 .500Z 和 .501Z 混在一批里）。字符串严格相等会把一批劈成两半，
 * 而「只截到秒」会在 xx:59.999 / xy:00.001 这种跨秒边界上丢行。所以用容差。
 */
export function clusterByBatch<T extends { at: string }>(rows: T[], toleranceMs = 5_000): T[][] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: T[][] = [];
  for (const row of sorted) {
    const last = out[out.length - 1];
    const t = Date.parse(row.at);
    if (last && Number.isFinite(t) && t - Date.parse(last[last.length - 1].at) <= toleranceMs) {
      last.push(row);
    } else {
      out.push([row]);
    }
  }
  return out;
}

export function emptyRuns(missing: string | null): FactorRunsPayload {
  return { batch: null, batches: [], batchIndex: -1, badLines: 0, missing };
}

export function emptyDiag(missing: string | null): FactorDiagPayload {
  return { shrinkFlip: null, shrinkBull: null, flowProbe: [], badLines: 0, missing };
}

export function emptyBaseline(missing: string | null): FactorBaselinePayload {
  return { name: null, text: null, bytes: 0, missing };
}

/**
 * 读因子 6 关判决日志。
 *
 * batchIndex 选批次：0 = 最旧，负数或缺省 = 最新（-1 即默认）。为什么按索引不按
 * 时间戳：同一次跑的各行 at 相差几毫秒，页面选择器拿不准该传哪一行的时间；索引
 * 由 batches 列表的位置决定，传错了也只是越界回退到最新一批。
 */
export async function readFactorRuns(batchIndex?: number): Promise<FactorRunsPayload> {
  const path = join(backtestDir(), "factor-runs.jsonl");
  try {
    const { rows, badLines } = parseLines<FactorRunRow>(await readFile(path, "utf8"));
    const batchesRaw = clusterByBatch(rows);
    const fallback = batchesRaw.length - 1;
    const wanted = batchIndex == null || batchIndex < 0 ? fallback : Math.min(batchIndex, fallback);
    const picked = batchesRaw[wanted] ?? [];
    const head = picked[0];
    return {
      batch: head
        ? {
            at: head.at,
            n: head.n,
            buckets: head.buckets,
            nDays: head.nDays,
            nTested: head.nTested,
            rows: picked,
          }
        : null,
      batches: batchesRaw.map((b) => ({
        at: b[0].at,
        count: b.length,
        n: b[0].n,
        offset: b[0].offset ?? 0,
        buckets: b[0].buckets,
      })),
      batchIndex: batchesRaw.length === 0 ? -1 : wanted,
      badLines,
      missing: null,
    };
  } catch (error) {
    return emptyRuns(`factor-runs.jsonl 读不到（${(error as Error).message}）`);
  }
}

/** 读归因与资金流探路。三种 kind 各自取最新一条；flowProbe 按持有期分组。 */
export async function readFactorDiag(): Promise<FactorDiagPayload> {
  const path = join(backtestDir(), "factor-diag.jsonl");
  try {
    const { rows, badLines } = parseLines<DiagRow>(await readFile(path, "utf8"));
    let shrinkFlip: ShrinkFlipDiag | null = null;
    let shrinkBull: ShrinkBullDiag | null = null;
    const flowByN = new Map<number, FlowProbeDiag>();
    for (const row of rows) {
      if (row.kind === "shrinkFlip") {
        if (!shrinkFlip || Date.parse(row.at) >= Date.parse(shrinkFlip.at)) shrinkFlip = row;
      } else if (row.kind === "shrinkBull") {
        if (!shrinkBull || Date.parse(row.at) >= Date.parse(shrinkBull.at)) shrinkBull = row;
      } else if (row.kind === "flowProbe") {
        const prev = flowByN.get(row.n);
        if (!prev || Date.parse(row.at) >= Date.parse(prev.at)) flowByN.set(row.n, row);
      }
    }
    return {
      shrinkFlip,
      shrinkBull,
      flowProbe: [...flowByN.values()].sort((a, b) => a.n - b.n),
      badLines,
      missing: null,
    };
  } catch (error) {
    return emptyDiag(`factor-diag.jsonl 读不到（${(error as Error).message}）`);
  }
}

/**
 * 读回测基线原文。文件名带日期，取目录里字典序最新的那个——以后换了新的
 * baseline 不用改代码。原文一字不解析，页面整段展示。
 */
export async function readBaseline(): Promise<FactorBaselinePayload> {
  try {
    const dir = backtestDir();
    const files = (await readdir(dir)).filter((f) => f.startsWith("baseline-") && f.endsWith(".txt"));
    if (files.length === 0) return emptyBaseline("backtest 目录里没有 baseline-*.txt");
    const name = files.sort().at(-1) as string;
    const text = await readFile(join(dir, name), "utf8");
    return { name, text, bytes: Buffer.byteLength(text, "utf8"), missing: null };
  } catch (error) {
    return emptyBaseline(`baseline 读不到（${(error as Error).message}）`);
  }
}
