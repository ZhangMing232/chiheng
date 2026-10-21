/**
 * 这个文件是干什么的：
 * 挑战者参数敏感度（VT3，学 Vibe 的「邻近参数检验」）——判决旁路标注，不改判决。
 *
 * 你需要知道的：
 * 冠军-挑战者的 Welch 判决只看「这套参数 vs 冠军」的逐笔收益差。参数踩在尖上
 * （悬崖）还是平台上，判决本身不说——t 值很高但邻域全崩的参数，转正后大概率
 * 均值回归。这里在判决落地时对挑战者自己的已平仓样本做参数邻域重模拟：
 * 把每笔交易的出场参数 ±一步，用 exitFill 在同一根 K 线上重撮合，看均值差多少。
 *
 * 铁律：
 * 1. **只标注，不判决**。fragile 只写报告和推送文案，promote/reject 一个字不动
 *    （AI-BOUNDARY：判决规则写死代码，改规则要用户拍板）。
 * 2. **只 perturb 挑战者自己设过的旋钮**。stopPct/targetPct 缺省 = 沿用建仓时的
 *    计划位（trade.stop / trade.target 原样记录在账上），重模拟时用记录值；
 *    把它捏造成数字等于发明数据。
 * 3. 重模拟是「同一批票、同一根 K 线、只改出场位」的反事实，不是新样本——
 *    报告里永远带 simulated/skipped 数，K 线范围外的交易（120 根窗口之前）
 *    如实跳过，不 silently 丢弃。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exitFill, netReturn } from "./journal-book.ts";
import { holdOf } from "./strategies.ts";
import { paramSensitivity, pbo, type SensitivityResult } from "./robustness.ts";
import type { Challenger } from "./challenger.ts";

/** 解析后的完整出场参数。null = 那维沿用建仓时的计划位（记录在交易上）。 */
export type RobustParams = { holdDays: number; stopPct: number | null; targetPct: number | null };

/** 旋钮白名单和步长（与 strategy-ai 冷启动播种的「小幅偏移」同量级）。 */
const KNOB_RANGES = { holdDays: [3, 30], stopPct: [4, 15], targetPct: [8, 60] } as const;
const STEP = { holdDays: 2, stopPct: 2, targetPct: 5 } as const;

/** 重模拟用的已平仓交易（从账本 days 里挑 variant 匹配、exit 非空的）。 */
export type ClosedTrade = {
  /** quote id（sh/sz/bj+代码），拿去取 K 线。 */
  id: string;
  /** 建仓日（day.date），exitFill 从这根 K 线之后开始撮合。 */
  entryDate: string;
  entry: number;
  /** 建仓时记录的 plan 位；stopPct/targetPct 为 null 的重模拟维度用它们。 */
  stop?: number;
  target?: number;
};

/**
 * 单旋钮 ±一步的邻域。没设过的旋钮（null）不出现在任何邻域里；
 * 越出白名单范围的步也砍掉（holdDays 2 天、stopPct 2%、targetPct 5%）。
 */
export function neighborParams(base: RobustParams): RobustParams[] {
  const out: RobustParams[] = [];
  for (const knob of ["holdDays", "stopPct", "targetPct"] as const) {
    const v: number | null = base[knob];
    if (v == null) continue;
    const range: readonly [number, number] = KNOB_RANGES[knob];
    for (const d of [-STEP[knob], STEP[knob]] as const) {
      const next: number = v + d;
      if (next >= range[0] && next <= range[1] && next !== v) {
        out.push({ ...base, [knob]: next } as RobustParams);
      }
    }
  }
  return out;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * 把一组已平仓交易在参数 params 下重模拟，返回平均净收益（扣费口径同 netReturn）。
 * 每笔：stop/target 有 perturbed 值就用 perturbed 值，没有就用建仓时的记录位；
 * 两者都缺、或 K 线取不到、或 exitFill 走不完（建仓日不在 120 根窗口内）→ 记 skipped。
 */
export async function simulateMean(
  trades: ClosedTrade[],
  barsOf: (id: string) => Promise<{ date: string; o?: number; h?: number; l?: number; c: number }[] | null>,
  params: RobustParams,
  limitPct: number | null = 10,
): Promise<{ mean: number | null; simulated: number; skipped: number; details: { date: string; ret: number }[] }> {
  const rets: number[] = [];
  const details: { date: string; ret: number }[] = [];
  let skipped = 0;
  for (const t of trades) {
    const stop = params.stopPct != null ? round2(t.entry * (1 - params.stopPct / 100)) : t.stop;
    const target = params.targetPct != null ? round2(t.entry * (1 + params.targetPct / 100)) : t.target;
    if (!(stop != null && stop > 0) || !(target != null && target > stop) || !(t.entry > 0)) {
      skipped += 1;
      continue;
    }
    let bars: Awaited<ReturnType<typeof barsOf>> = null;
    try {
      bars = await barsOf(t.id);
    } catch {
      bars = null;
    }
    if (!bars || bars.length === 0) {
      skipped += 1;
      continue;
    }
    const fill = exitFill(bars, t.entryDate, t.entry, stop, target, limitPct, params.holdDays);
    if (!fill) {
      skipped += 1;
      continue;
    }
    const net = netReturn(t.entry, fill.price);
    if (net == null) skipped += 1;
    else {
      rets.push(net);
      details.push({ date: fill.date, ret: net });
    }
  }
  if (rets.length === 0) return { mean: null, simulated: 0, skipped, details };
  return { mean: rets.reduce((s, x) => s + x, 0) / rets.length, simulated: rets.length, skipped, details };
}

export type ChallengerRobustReport = {
  id: string;
  at: string;
  /** 触发这次评估的判决。 */
  verdict: "promote" | "reject" | "inconclusive";
  base: RobustParams;
  /** 基准参数重模拟均值（小数，0.01 = 1%）。null = 一笔都模拟不出来。 */
  baseMean: number | null;
  /** 每个邻域点的均值。params 里只列出和基准不同的旋钮。 */
  neighbors: { holdDays?: number; stopPct?: number; targetPct?: number; mean: number | null }[];
  /** true = 悬崖（邻域变号或变异系数 > 1）；false = 平台；null = 样本不足判不了。 */
  fragile: boolean | null;
  simulated: number;
  skipped: number;
  /** VT5 CSCV 过拟合概率（0~1，越高越像往历史上调参）。null = 配置/期数不足没算。 */
  pbo: number | null;
  /** 参与 PBO 的 CSCV 切分数（S=4 → 70）。pbo 为 null 时也为 null。 */
  pboSplits: number | null;
  /** 给人看的结论一句话。 */
  note: string;
};

const fmtPct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);

/**
 * 判决落地时对挑战者做邻域敏感度评估。trades 至少要 MIN_TRADES 笔已平仓，
 * 太少返回 null（不硬凑结论）。数学上套 robustness.paramSensitivity，
 * evaluate 读预先算好的重模拟表——paramSensitivity 是同步的，重模拟是异步的，
 * 先把网格全跑完再喂给它。
 */
/** 评估只需要挑战者的身份和三个旋钮，不要完整的 Challenger（UI/测试传部分字段也能跑）。 */
export type RobustChallenger = Pick<Challenger, "id" | "style"> &
  Partial<Pick<Challenger, "holdDays" | "stopPct" | "targetPct">>;

export async function robustnessReport(args: {
  chal: RobustChallenger;
  verdict: ChallengerRobustReport["verdict"];
  trades: ClosedTrade[];
  barsOf: (id: string) => Promise<{ date: string; o?: number; h?: number; l?: number; c: number }[] | null>;
  limitPct?: number | null;
  minTrades?: number;
  now?: string;
}): Promise<ChallengerRobustReport | null> {
  const { chal, trades, barsOf } = args;
  const limitPct = args.limitPct ?? 10;
  const minTrades = args.minTrades ?? 5;
  if (trades.length < minTrades) return null;

  const base: RobustParams = {
    holdDays: chal.holdDays ?? holdOf(chal.style as Parameters<typeof holdOf>[0]),
    stopPct: chal.stopPct ?? null,
    targetPct: chal.targetPct ?? null,
  };
  const neighbors = neighborParams(base);

  const baseRun = await simulateMean(trades, barsOf, base, limitPct);
  const neighborRuns: { params: RobustParams; run: Awaited<ReturnType<typeof simulateMean>> }[] = [];
  for (const p of neighbors) {
    neighborRuns.push({ params: p, run: await simulateMean(trades, barsOf, p, limitPct) });
  }

  // 数学照 paramSensitivity（变号或 CV>1 = 悬崖），但只在一半以上邻域点
  // 模拟得出来时才下结论——网格缺一半还说「平台」是在编故事。
  const usable = neighborRuns.filter((r) => r.run.mean != null);
  let fragile: boolean | null = null;
  let result: SensitivityResult<RobustParams> | null = null;
  if (baseRun.mean != null && usable.length > 0 && usable.length >= Math.ceil(neighborRuns.length / 2)) {
    const means = new Map<string, number>();
    means.set(paramsKey(base), baseRun.mean);
    for (const r of usable) means.set(paramsKey(r.params), r.run.mean as number);
    result = paramSensitivity(base, neighbors, (p) => means.get(paramsKey(p)) ?? baseRun.mean as number);
    fragile = result.fragile;
  }

  // VT5：CSCV PBO（过拟合概率）。把基准 + 邻域网格的逐笔重模拟收益按平仓日排序
  // 均分成 8 期（2S，S=4），得到 配置×期 矩阵丢给 robustness.pbo。同样只标注
  // 不判决——它回答的是「这套参数相对邻域是不是往历史上调出来的」。
  const PBO_PERIODS = 8;
  let pboResult: ReturnType<typeof pbo> = null;
  {
    const grids = [
      baseRun.details,
      ...neighborRuns.map((r) => r.run.details),
    ].filter((details) => details.length > 0);
    const allDates = [...new Set(grids.flatMap((d) => d.map((x) => x.date)))].sort();
    if (grids.length >= 3 && allDates.length >= PBO_PERIODS) {
      const dateIdx = new Map(allDates.map((d, i) => [d, i]));
      const matrix = grids.map((details) => {
        const buckets: number[][] = Array.from({ length: PBO_PERIODS }, () => []);
        for (const d of details) {
          const idx = dateIdx.get(d.date) as number;
          const p = Math.min(Math.floor((idx * PBO_PERIODS) / allDates.length), PBO_PERIODS - 1);
          buckets[p].push(d.ret);
        }
        return buckets.map((b) => (b.length > 0 ? b.reduce((s, x) => s + x, 0) / b.length : null));
      });
      pboResult = pbo(matrix, 4);
    }
  }

  const neighborLines = neighborRuns.map((r) => {
    const diff: Partial<Record<"holdDays" | "stopPct" | "targetPct", number>> = {};
    for (const knob of ["holdDays", "stopPct", "targetPct"] as const) {
      if (r.params[knob] !== base[knob]) diff[knob] = r.params[knob] as number;
    }
    return { ...diff, mean: r.run.mean };
  });

  const pboSuffix =
    pboResult == null
      ? ""
      : `；PBO（过拟合概率）=${(pboResult.pbo * 100).toFixed(0)}%（CSCV ${pboResult.nSplits} 切分${pboResult.pbo >= 0.5 ? "，参数相对邻域更像往历史上调出来的" : ""}）`;

  const note =
    baseRun.mean == null
      ? `敏感度：${trades.length} 笔里一笔都模拟不出来（K 线窗口外或缺计划位），本次不评估`
      : fragile == null
        ? `敏感度：基准 ${fmtPct(baseRun.mean)}，但邻域只模拟出 ${usable.length}/${neighborRuns.length} 点，样本不足不下结论${pboSuffix}`
        : fragile
          ? `敏感度：基准 ${fmtPct(baseRun.mean)}，但邻域均值 ${fmtPct(Math.min(...usable.map((r) => r.run.mean as number)))} ~ ${fmtPct(Math.max(...usable.map((r) => r.run.mean as number)))}——参数是悬崖不是平台，转正成绩可能只是踩中尖点${pboSuffix}`
          : `敏感度：基准 ${fmtPct(baseRun.mean)}，邻域 ${fmtPct(Math.min(...usable.map((r) => r.run.mean as number)))} ~ ${fmtPct(Math.max(...usable.map((r) => r.run.mean as number)))}，参数在平台上${pboSuffix}`;

  return {
    id: chal.id,
    at: args.now ?? new Date().toISOString(),
    verdict: args.verdict,
    base,
    baseMean: baseRun.mean,
    neighbors: neighborLines,
    fragile,
    simulated: baseRun.simulated,
    skipped: baseRun.skipped,
    pbo: pboResult?.pbo ?? null,
    pboSplits: pboResult?.nSplits ?? null,
    note,
  };
}

function paramsKey(p: RobustParams): string {
  return `${p.holdDays}:${p.stopPct ?? "-"}:${p.targetPct ?? "-"}`;
}

// ── 落盘：data/challenger-robustness.json，按挑战者 id 各留最新一份 ──

const dataDir = () => join(process.cwd(), "data");
export const robustnessPath = () => join(dataDir(), "challenger-robustness.json");

export async function readRobustness(): Promise<{ list: ChallengerRobustReport[] }> {
  try {
    const parsed = JSON.parse(await readFile(robustnessPath(), "utf8"));
    if (parsed && Array.isArray(parsed.list)) return parsed as { list: ChallengerRobustReport[] };
  } catch {
    // 没有文件 = 还没评估过，正常。
  }
  return { list: [] };
}

/** 同 id 覆盖、最多留 20 条（老判决的评估会被新判决顶掉）。 */
export async function writeRobustness(report: ChallengerRobustReport) {
  const file = await readRobustness();
  const list = [report, ...file.list.filter((r) => r.id !== report.id)].slice(0, 20);
  await mkdir(dataDir(), { recursive: true });
  await writeFile(robustnessPath(), JSON.stringify({ list }, null, 2));
}
