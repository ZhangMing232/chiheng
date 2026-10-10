/**
 * 这个文件是干什么的：
 * 自动进化的熔断器。autoEvolve 开着的时候，AI 每天收盘后自己跑一轮进化——
 * 没有人盯着。AI 配置失效、API 欠费、prompt 不合规……任何一类问题都会让
 * 进化轮轮空转，而空转本身不会报错给任何人看。
 *
 * 学 deepseek-harness-quant dev_auto.py 的 fail-safe：连续 N 轮没有任何产出
 * 就自动断电（它断的是计划任务，这里断的是 autoEvolve 开关），并推一条消息
 * 给主人。断电不是惩罚，是把「默默空转」变成「必须人来看看」。
 *
 * 你需要知道的：
 * 1. 判决口径：一层成功（ok）就算有产出。两层**都**失败才计一次——
 *    一层挂一层正常说明系统在半个脑袋工作，不该断电。
 * 2. MAX_CONSECUTIVE_ERRORS = 3：给「AI 服务商抽风一晚」留余地，也是上限。
 *    改这里 = 改规则本身，要带着理由改（和 CHALLENGER_RULE / DECAY_RULE 同规矩）。
 * 3. 恢复 = 人在 /ai 页重新打开 autoEvolve。手动跑（evolve-once / 页面按钮）
 *    不受熔断限制——熔断只针对无人值守的自动轮。
 * 4. 状态落 data/evolve-breaker.json，和 ai-prefs.json 分开：开关是行为，
 *    熔断记录是审计——谁、什么时候、为什么断的电，要留档。
 * 5. 纯函数（nextBreakerState / shouldTrip）不碰 fs，直接单测。
 */

/** 预先登记的熔断标准。改这里等于改规则本身，要带着理由改。 */
export const BREAKER_RULE = {
  /** 连续多少轮「两层都失败」就断电。 */
  maxConsecutiveErrors: 3,
} as const;

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type BreakerState = {
  /** 当前连续双败轮数。任何一层成功就清零。 */
  consecutiveErrors: number;
  /** 非 null = 已断电（时刻 + 原因）。重新打开开关成功一轮后清空。 */
  trippedAt: string | null;
  /** 断电原因原文（最后一轮两层各自的 error）。 */
  trippedReason: string;
};

/** 一轮自动进化的两层结果（只要 ok 布尔，不依赖具体层类型）。 */
export type EvolveLayerOutcome = { ok: boolean; error?: string };

export const initialBreakerState = (): BreakerState => ({
  consecutiveErrors: 0,
  trippedAt: null,
  trippedReason: "",
});

/** 这一轮该不该计入：两层都失败才算一次空转。 */
export function isDoubleFailure(factor: EvolveLayerOutcome, strategy: EvolveLayerOutcome): boolean {
  return !factor.ok && !strategy.ok;
}

/** 这一轮回合之后，连续双败数变成几。成功（任一层 ok）清零。 */
export function nextConsecutive(state: BreakerState, factor: EvolveLayerOutcome, strategy: EvolveLayerOutcome): number {
  if (!isDoubleFailure(factor, strategy)) return 0;
  return state.consecutiveErrors + 1;
}

/**
 * 推进熔断状态。返回新状态（不改入参）。
 * 已熔断的态原样返回——恢复不在这个函数里，在「重新打开开关 + 成功一轮」。
 */
export function nextBreakerState(
  state: BreakerState,
  factor: EvolveLayerOutcome,
  strategy: EvolveLayerOutcome,
  at: string,
): BreakerState {
  if (state.trippedAt) return state;
  const consecutiveErrors = nextConsecutive(state, factor, strategy);
  if (consecutiveErrors < BREAKER_RULE.maxConsecutiveErrors) return { ...state, consecutiveErrors };
  return {
    consecutiveErrors,
    trippedAt: at,
    trippedReason: `连续 ${consecutiveErrors} 轮两层都失败。因子层：${factor.error ?? "未报原因"}；策略层：${strategy.error ?? "未报原因"}`,
  };
}

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const breakerPath = () => join(dataDir(), "evolve-breaker.json");

/** 读状态。文件不存在/坏了 → 初始态，绝不抛错。 */
export async function readBreaker(): Promise<BreakerState> {
  try {
    const parsed = JSON.parse(await readFile(breakerPath(), "utf8")) as Partial<BreakerState>;
    return {
      consecutiveErrors: typeof parsed.consecutiveErrors === "number" ? parsed.consecutiveErrors : 0,
      trippedAt: typeof parsed.trippedAt === "string" ? parsed.trippedAt : null,
      trippedReason: typeof parsed.trippedReason === "string" ? parsed.trippedReason : "",
    };
  } catch {
    return initialBreakerState();
  }
}

export async function writeBreaker(state: BreakerState): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(breakerPath(), JSON.stringify(state, null, 2));
}

/** 人在 /ai 页重新打开 autoEvolve 时调用：清零计数、解除熔断。 */
export async function resetBreaker(): Promise<void> {
  await writeBreaker(initialBreakerState());
}
