/**
 * 规则改动的效果回验（2026-11-14，反思闭环的最后一块）。
 *
 * 这个文件解决什么问题：
 * 优化器会依据 AI 诊断自动改 `challenger-rule`（earlyRejectDays / earlyRejectGap 等），
 * 每次改动都写进 `data/rule-change-log.jsonl`。但**改完从来没有回头验证过**：
 * 2026-10-30 到 11-11 之间 earlyRejectDays 被来回摆了 6 次
 * （15→3→5→10→12→20→30），earlyRejectGap 摆了 4 次（0.05→6→0.05→0.08）。
 * 这是典型的「盲调」——每次改动都是基于当时的诊断，但没有机制回答
 * 「上一次改到底有没有用」。
 *
 * 为什么这让反思链断裂（用户 2026-11-13 的原话：没有外部 AI 也要能自我进化）：
 *   知道亏损 → 分析原因 → 给办法 → 执行 → **验证**
 * 最后一步缺失时，前三步做得再好也可能在原地打转，甚至越调越差。
 * 有了回验，系统才能自己说出「这次改动无效，回滚」或「这次改动有效，保留」，
 * 而不是等下一个人来看日志。
 *
 * 纪律：
 * - **只读 + 只写回验报告**，不改规则、不回滚（回滚要人拍板，见 `revertAdvice`）。
 * - 改动后至少要积累 N 个交易日才有资格判「有效/无效」，样本不够就写「还没结论」。
 * - 判定用**改动前后的策略表现差**，不是单看改完之后的绝对值——市场同时在动。
 * - 纯函数部分（`evaluateRuleChangeEffect`）零 IO，便于单测；IO 在 `pollRuleChangeEffects`。
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

/** 一条规则改动的效果回验报告。 */
export type RuleChangeEffect = {
  /** 对应 rule-change-log 里的那条（at + key 唯一） */
  at: string;
  key: string;
  from: number;
  to: number;
  /** 回验时刻 */
  evaluatedAt: string;
  /** 改动后过了几个交易日 */
  daysAfter: number;
  /** 改动前后各取同样长度的窗口比较；null = 数据不够 */
  beforeAvg: number | null;
  afterAvg: number | null;
  /** 差值（after - before）。正数=改完后更好 */
  delta: number | null;
  /** 结论：effective / ineffective / inconclusive（样本不够）/ pending（还没到观察期） */
  verdict: "effective" | "ineffective" | "inconclusive" | "pending";
  /** 一句话说清依据 */
  reason: string;
  /** 回滚建议（只在 ineffective 时给，且只是建议，不自动执行） */
  revertAdvice: string | null;
};

/**
 * 判定门槛：改动后至少积累这么多个交易日才允许下结论。
 *
 * 2026-11-14 首版写 5 天，实测立刻抓到自己犯的错：切在 11-05 时改前 247 笔、
 * 改后只有 53 笔，改后那段「+5.26%」被判成 effective——那不是规则有效，
 * 是**改后样本又少又短**（22 个交易日总共才 300 笔已平仓）。
 * 复盘：观察期太短 + 样本不设下限，就会被抽样波动骗。改成 10 个交易日。
 */
export const MIN_DAYS_AFTER = 10;

/**
 * 前后两段各自的最小样本量。低于这个数不判——两段样本差太多时，
 * 「均值差」测的其实是「两段时间的市场差」，不是规则的效果。
 */
export const MIN_TRADES_PER_SIDE = 30;
/** 「有效/无效」的最小差值（百分点）。小于这个数算 inconclusive——噪声区间内不判。 */
export const EFFECT_THRESHOLD_PP = 0.3;

/**
 * 纯函数：给定改动前后两段窗口的逐笔收益，判断这次改动有没有用。
 *
 * 为什么用「前后窗口差」而不是「改完后绝对值」：市场本身在涨跌，
 * 只看改完后 +0.5% 说明不了规则好不好。要对比改动前同长度的表现。
 *
 * @param before 改动前的逐笔收益率（小数，如 0.0123 = +1.23%）
 * @param after  改动后的逐笔收益率
 * @param daysAfter 改动后已过的交易日数
 */
export function evaluateRuleChangeEffect(args: {
  at: string;
  key: string;
  from: number;
  to: number;
  before: number[];
  after: number[];
  daysAfter: number;
  now?: string;
}): RuleChangeEffect {
  const now = args.now ?? new Date().toISOString();
  const { at, key, from, to, before, after, daysAfter } = args;
  const base = { at, key, from, to, evaluatedAt: now, daysAfter };

  // 还没到观察期：不判，写 pending。样本不够就下结论等于编。
  if (daysAfter < MIN_DAYS_AFTER) {
    return {
      ...base,
      beforeAvg: null,
      afterAvg: null,
      delta: null,
      verdict: "pending",
      reason: `改动后只过了 ${daysAfter} 个交易日，未到 ${MIN_DAYS_AFTER} 天观察期——先不判`,
      revertAdvice: null,
    };
  }

  // 两段都要有足够样本，否则 inconclusive。10 笔太少：实测 53 笔就能演出 +6.87pp 的假改善。
  if (before.length < MIN_TRADES_PER_SIDE || after.length < MIN_TRADES_PER_SIDE) {
    return {
      ...base,
      beforeAvg: null,
      afterAvg: null,
      delta: null,
      verdict: "inconclusive",
      reason: `样本不足（改前 ${before.length} 笔 / 改后 ${after.length} 笔，各需 ≥${MIN_TRADES_PER_SIDE}）——不下结论`,
      revertAdvice: null,
    };
  }

  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const beforeAvg = avg(before);
  const afterAvg = avg(after);
  const delta = afterAvg - beforeAvg;
  const deltaPp = delta * 100;

  if (Math.abs(deltaPp) < EFFECT_THRESHOLD_PP) {
    return {
      ...base,
      beforeAvg,
      afterAvg,
      delta,
      verdict: "inconclusive",
      reason: `改前 ${(beforeAvg * 100).toFixed(2)}% → 改后 ${(afterAvg * 100).toFixed(2)}%，差 ${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(2)}pp 落在 ±${EFFECT_THRESHOLD_PP}pp 噪声区——判不出好坏`,
      revertAdvice: null,
    };
  }

  if (deltaPp > 0) {
    return {
      ...base,
      beforeAvg,
      afterAvg,
      delta,
      verdict: "effective",
      reason: `改前 ${(beforeAvg * 100).toFixed(2)}% → 改后 ${(afterAvg * 100).toFixed(2)}%，改善 +${deltaPp.toFixed(2)}pp（超过噪声区）——保留这次改动`,
      revertAdvice: null,
    };
  }

  return {
    ...base,
    beforeAvg,
    afterAvg,
    delta,
    verdict: "ineffective",
    reason: `改前 ${(beforeAvg * 100).toFixed(2)}% → 改后 ${(afterAvg * 100).toFixed(2)}%，恶化 ${deltaPp.toFixed(2)}pp——这次改动没帮上忙`,
    revertAdvice: `建议把 ${key} 从 ${to} 回滚到 ${from}（需人拍板，不自动执行）`,
  };
}

export function ruleChangeEffectPath(): string {
  return join(dataDir(), "rule-change-effects.jsonl");
}

/** 读回验报告（新的在前）。 */
export async function readRuleChangeEffects(): Promise<RuleChangeEffect[]> {
  try {
    const raw = await readFile(ruleChangeEffectPath(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as RuleChangeEffect;
        } catch {
          return null;
        }
      })
      .filter((x): x is RuleChangeEffect => x != null)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 回验一条改动：从账本里取改动前后相同长度的窗口，比较平均收益。
 *
 * 为什么用账本而不是回测：规则改的是**挑战者**行为（哪些套策略该被提前否决），
 * 账本才是它真实作用的地方。回测不跑挑战者逻辑。
 */
export async function pollRuleChangeEffect(args: {
  at: string;
  key: string;
  from: number;
  to: number;
  trades: { entryDate: string; ret: number }[];
  tradingDays: string[];
}): Promise<RuleChangeEffect | null> {
  const { at, key, from, to, trades, tradingDays } = args;
  const changeDate = at.slice(0, 10);
  const afterDays = tradingDays.filter((d) => d > changeDate);
  const beforeDays = tradingDays.filter((d) => d < changeDate).slice(-Math.max(afterDays.length, MIN_DAYS_AFTER));

  const before = trades.filter((t) => beforeDays.includes(t.entryDate)).map((t) => t.ret);
  const after = trades.filter((t) => afterDays.includes(t.entryDate)).map((t) => t.ret);

  return evaluateRuleChangeEffect({ at, key, from, to, before, after, daysAfter: afterDays.length });
}

/** 把回验结果追加落盘。同一 (at,key) 重复回验覆盖旧结论——结论会随样本增长变。 */
export async function appendRuleChangeEffect(effect: RuleChangeEffect): Promise<void> {
  try {
    await mkdir(dirname(ruleChangeEffectPath()), { recursive: true });
    await appendFile(ruleChangeEffectPath(), JSON.stringify(effect) + "\n", "utf8");
  } catch {
    // 回验写不进去只丢一条记录，不影响规则本身。
  }
}
