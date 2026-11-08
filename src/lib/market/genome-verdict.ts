/**
 * 这个文件是干什么的：
 * 把「回测判决」写回策略基因组文件（data/strategy-genome.json）——**判决回写**。
 *
 * 为什么必须有它（这是整条轨道最后一块拼图）：
 * GenomeStatus 里有 "promoted" / "rejected" / "tombstone" 三个状态，但如果**没有任何东西
 * 去写它们**，这个文件就只会长不会收：AI 提一批 spec → 永远停在 "proposed" → 没人判 →
 * 没人知道哪套死了 → 近亲封禁学不到「什么死过」→ 下一轮照提一样的。
 * 轨道变成只进不出的队列。所以判决必须落盘，死的要变成墓碑，活的要能上线。
 *
 * 你需要知道的（纪律）：
 * 1. **判决门槛就是白皮书 §4 那条**：`design/STRATEGY-GEN2.md` §4 写死了「对应回测 |t| ≥ 2，
 *    或实盘挑战者转正」才准进选股条件。这里照抄：聚类 |t| ≥ 2 **且**前后同向，
 *    两道都过才算站住。**信噪比不是逐笔 t**——同一天平仓的票共享当天 beta，
 *    逐笔 t 能虚高 5~7 倍（10-28 已量到）。
 * 2. **样本不够不是判决**。只有 20 笔、或者回测没跑成，都只是「还没结论」，
 *    状态留在 "testing"，不许按「没结论 = 死了」处理。
 * 3. **纯函数**，不碰 fs。落盘由调用方（scripts/strategy-verdict.ts）做。
 */

import type { GenomeCandidate, GenomeStatus } from "./strategy-genome.ts";

/** 回测 dump 里的逐笔明细（只用到这几个字段）。 */
export type VerdictTrade = { ret?: number; bench?: number; exitDate?: string };

/**
 * 逐笔超额（ret - bench）按平仓日聚类的稳健 t。
 *
 * 为什么必须聚类：同一天平仓的票共享当天市场 beta，不是独立观测。逐笔 t 会把
 * 126 个交易日的 350 笔当成 350 个独立样本，t 能虚高（11-05 实测：基因组候选
 * 逐笔 t +1.27，信噪比 +0.72）。
 *
 * **口径和 scripts/cluster-t.py 完全一致**（同样的 G/(G-1) 小样本修正、同样的 N² 分母），
 * 已用 11-05 的真实 dump 交叉校验：中期反转 JS −0.98 / python −0.98；
 * 基因组候选 JS +0.72 / python +0.72。谁改了这里的公式，cluster-t.py 那边也得跟着复核。
 *
 * ⚠️ **退化样本必须报 null，不能报一个离谱的大数**。如果所有笔的超额几乎完全相同
 * （浮点残差让方差 ≈1e-37 而不是 0），直接代公式会算出 t ≈ 1e16 —— 一个「巨额通过」
 * 的假象。这里显式判「退化」并返回 null（= 算不出来 = 不是判决）。
 * 11-05 修：老的 JS 版（strategy-verdict.ts 内联那份）在这种样本上就出过 5.76e15。
 */
export function clusterTOf(
  trades: VerdictTrade[],
): { clusterT: number | null; excess: number; n: number; days: number; tIid: number | null } | null {
  const usable = trades.filter((t) => typeof t.ret === "number" && typeof t.bench === "number");
  if (usable.length < 2) return null;
  const exc = usable.map((t) => (t.ret as number) - (t.bench as number));
  const n = exc.length;
  const mean = exc.reduce((s, v) => s + v, 0) / n;

  // 逐笔 t（假设独立）——cluster-t.py 也算这个，用来对比聚类前后差多少。
  const varIid = exc.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const tIid = varIid > 0 ? mean / Math.sqrt(varIid / n) : null;

  // 按平仓日聚类
  const byDay = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const d = usable[i].exitDate ?? "";
    const list = byDay.get(d);
    if (list) list.push(exc[i]);
    else byDay.set(d, [exc[i]]);
  }
  const g = byDay.size;
  // 全部同一天平仓 = 只有 1 个簇，簇稳健方差估不出来（cluster-t.py 返回 nan）。
  if (g < 2) return { clusterT: null, excess: mean, n, days: g, tIid };

  // 退化检测：所有超额几乎完全相同 → 方差在数值上是 0，代公式会炸出假的大 t。
  const maxDev = exc.reduce((m, x) => Math.max(m, Math.abs(x - mean)), 0);
  const scale = Math.max(Math.abs(mean), 1e-12);
  if (maxDev <= scale * 1e-12) {
    return { clusterT: null, excess: mean, n, days: g, tIid };
  }

  // meat = Σ_g (Σ_{i∈g} (e_i - mean))²
  let meat = 0;
  for (const list of byDay.values()) {
    const s = list.reduce((a, e) => a + (e - mean), 0);
    meat += s * s;
  }
  // K=1 → (N-1)/(N-K) = 1，写出来是提醒别漏了小样本修正那一项（和 cluster-t.py 同款）
  const small = (n - 1) / (n - 1);
  const vClu = ((g / (g - 1)) * small * meat) / (n * n);
  const clusterT = vClu > 0 ? mean / Math.sqrt(vClu) : null;
  return { clusterT, excess: mean, n, days: g, tIid };
}

/**
 * 前后半段方向是否同向（按平仓日排序切一半，比两段的超额均值）。
 * null = 算不出来（样本太短）——**null 不等于「前后不同向」**，判决时区别对待。
 */
export function halvesSameSignOf(trades: VerdictTrade[]): boolean | null {
  const usable = trades
    .filter((t) => typeof t.ret === "number" && typeof t.bench === "number")
    .sort((a, b) => (a.exitDate ?? "").localeCompare(b.exitDate ?? ""));
  if (usable.length < 8) return null;
  const half = Math.floor(usable.length / 2);
  const mean = (rows: VerdictTrade[]) =>
    rows.length === 0 ? null : rows.reduce((s, t) => s + ((t.ret as number) - (t.bench as number)), 0) / rows.length;
  const h1 = mean(usable.slice(0, half));
  const h2 = mean(usable.slice(half));
  if (h1 == null || h2 == null) return null;
  return Math.sign(h1) === Math.sign(h2);
}

/** 从逐笔明细造出判决输入（跑成了、有多少笔、超额多少、信噪比多少、前后同不同向）。 */
export function verdictFromTrades(trades: VerdictTrade[]): GenomeVerdictInput {
  const s = clusterTOf(trades);
  return {
    ran: true,
    trades: trades.filter((t) => typeof t.ret === "number" && typeof t.bench === "number").length,
    excessPp: s ? s.excess * 100 : null,
    clusteredT: s ? s.clusterT : null,
    halvesSameSign: halvesSameSignOf(trades),
  };
}
/** 判决所需的最小成交笔数。低于这个数不判生死，只说「还没结论」。 */
export const GENOME_MIN_TRADES = 30;

/** 白皮书 §4 的 |t| 门槛（聚类稳健 t）。 */
export const GENOME_T_GATE = 2;

export type GenomeVerdictInput = {
  /** 回测跑成了吗。false = 没跑成，不算判决。 */
  ran: boolean;
  /** 成交笔数。 */
  trades: number;
  /** 超额（百分点）：逐笔 (ret - bench) 等权均值。 */
  excessPp: number | null;
  /** 聚类稳健 t（按 exitDate 聚类）。 */
  clusteredT: number | null;
  /** 前后半段是否同向。null = 还没算（不算前后不同向）。 */
  halvesSameSign: boolean | null;
  /** 附注（原样落盘，给人看）。 */
  note?: string;
};

export type GenomeVerdictOutcome = {
  status: GenomeStatus;
  /** 败在哪几关（空 = 全过）。 */
  failedGates: string[];
  /** 一句话说清为什么。 */
  reason: string;
};

/**
 * 判决：聚类 |t| ≥ 2 且前后同向 → 站住（promoted）；
 * 差一道 → 判死（rejected）；样本不够 / 没跑成 → 还没结论（testing）。
 */
export function judgeGenomeVerdict(v: GenomeVerdictInput): GenomeVerdictOutcome {
  if (!v.ran) {
    return { status: "testing", failedGates: [], reason: `回测没跑成，不算判决${v.note ? `：${v.note}` : ""}` };
  }
  if (v.trades < GENOME_MIN_TRADES) {
    return {
      status: "testing",
      failedGates: [],
      reason: `样本不足（${v.trades} 笔 < ${GENOME_MIN_TRADES} 笔），不是判决——继续攒，别当成死了`,
    };
  }
  if (v.clusteredT == null || !Number.isFinite(v.clusteredT)) {
    return { status: "testing", failedGates: [], reason: "信噪比算不出来（笔数或平仓日不够），不是判决" };
  }
  const t = v.clusteredT;
  if (Math.abs(t) < GENOME_T_GATE) {
    return {
      status: "rejected",
      failedGates: ["信噪比"],
      reason: `信噪比=${t.toFixed(2)} 未过 |t|≥${GENOME_T_GATE}（超额 ${fmtPp(v.excessPp)}）`,
    };
  }
  if (v.halvesSameSign === false) {
    return {
      status: "rejected",
      failedGates: ["前后同向"],
      reason: `前后半段翻脸（信噪比=${t.toFixed(2)} 虽过线，但前后不同向）`,
    };
  }
  // null = 算不出来（样本太短 / 平仓日不够），**不是「前后同向」**。
  // 2026-11-08 全量体检：这里原先直接落到 promoted，理由还写「过线且前后同向」——
  // 两道关缺一道却算过关，是明确撒谎。白皮书要求两道都过，算不出来就是还没结论。
  if (v.halvesSameSign == null) {
    return {
      status: "testing",
      failedGates: [],
      reason: `信噪比=${t.toFixed(2)} 过线，但前后半段同向算不出来，不是判决——继续攒样本`,
    };
  }
  return {
    status: "promoted",
    failedGates: [],
    reason: `信噪比=${t.toFixed(2)} 过线且前后同向（超额 ${fmtPp(v.excessPp)}，${v.trades} 笔）`,
  };
}

function fmtPp(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return "?";
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}pp`;
}

/**
 * 把「回测根本判不了」的候选标掉（用它用到的变量回测取不到）。
 *
 * 为什么单独处理：这类 spec 永远不会出现在回测 dump 里（注册阶段就被跳过了），
 * 如果不管，它会永远停在 "proposed" —— 队列只进不出，近亲封禁也拿不到它的教训。
 * **注意这不是「判它没 alpha」，是「判它没法验」**——理由写清楚，别让人误读成策略被判死。
 */
export function applyUnjudgeableRejection(
  list: GenomeCandidate[],
  missingById: Record<string, string>,
  at: string = new Date().toISOString(),
): GenomeCandidate[] {
  return list.map((c) => {
    const missing = missingById[c.id];
    if (!missing) return c;
    const reason = `回测判不了（${missing}）——这条 spec 永远验不了，不留在队列里`;
    return {
      ...c,
      status: "rejected" as GenomeStatus,
      failedGates: ["可判性"],
      note: `${c.note ?? ""}｜${at.slice(0, 10)}：${reason}`.trim(),
      verdict: {
        at,
        trades: 0,
        excessPp: null,
        clusteredT: null,
        halvesSameSign: null,
        reason,
      },
    };
  });
}

/**
 * 把判决写回候选列表。**没找到这个 id 就原样返回**（不静默吞——调用方自己比对前后长度）。
 */
export function applyGenomeVerdict(
  list: GenomeCandidate[],
  specId: string,
  v: GenomeVerdictInput,
  at: string = new Date().toISOString(),
): GenomeCandidate[] {
  const outcome = judgeGenomeVerdict(v);
  return list.map((c) => {
    if (c.id !== specId) return c;
    // 判决段幂等：**先剥掉上一次写的判决段再写新的**。
    // 否则每日判决刷新一次、note 就长一段——跑一个月 note 里堆 30 遍同一个判决。
    const base = (c.note ?? "").split("｜判决 ")[0].trim();
    return {
      ...c,
      status: outcome.status,
      failedGates: outcome.failedGates.length > 0 ? outcome.failedGates : c.failedGates,
      note: `${base}｜判决 ${at.slice(0, 10)}：${outcome.reason}`.trim(),
      verdict: {
        at,
        trades: v.trades,
        excessPp: v.excessPp,
        clusteredT: v.clusteredT,
        halvesSameSign: v.halvesSameSign,
        reason: outcome.reason,
      },
    };
  });
}
