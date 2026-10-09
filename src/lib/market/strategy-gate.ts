/**
 * 这个文件是干什么的：
 * 策略级自动闸门：哪套策略实盘证据显示「在亏」就自动停用，冷却一段时间后假释
 * （每天限 1 只），假释样本转正恢复满仓，再犯冷却翻倍。
 *
 * 你需要知道的：
 * 判决标准在 STRATEGY_GATE 里预先登记（pre-registration），跑之前定死、写进代码，
 * 事后看数据挑标准是过拟合的入口。统计口径：最近 window 笔已平仓、扣费后收益、
 * t ≤ −2 判负（均值比 0 低两个标准误——单笔波动大，几百笔的均值也能是运气，
 * 和 README 回测纪律同款）。
 * 状态存在 data/strategy-gates.json，记账进程每分钟新起一次，状态必须落盘。
 * 停用只停「新开仓」：持仓的止损止盈照跑（和 hardGate 同一立场）。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isTradingDay } from "./session.ts";

/** 预先登记的判决标准。改这里等于改规则本身，要带着理由改。 */
export const STRATEGY_GATE = {
  /** 判决窗口：最近 N 笔已平仓（按平仓日顺序）。攒不够 N 笔不判决——小样本的 t 值是噪音。 */
  window: 20,
  /** t ≤ −2 判「这套在亏」→ 停用。 */
  disableT: -2,
  /** 首次冷却：停用多少个交易日后假释（每天限 1 只）。 */
  cooldownDays: 10,
  /** 再犯冷却翻倍的上限。 */
  maxCooldownDays: 40,
  /** 假释转正：假释期间攒够 window 笔且 t > 0 → 恢复每天 10 只。 */
  restoreT: 0,
} as const;

export type GateRecord = {
  state: "disabled" | "paroled";
  /** 进入当前状态的交易日。disabled 时用于数冷却天数，paroled 时用于攒样本。 */
  since: string;
  /** 当前冷却期长度（交易日）。再犯翻倍：10 → 20 → 40 封顶。 */
  cooldownDays: number;
  /** 第几次被停用。1 = 首次。 */
  strikes: number;
  reason: string;
};

export type GatesFile = Record<string, GateRecord>;

export function gatesPath(): string {
  return join(process.cwd(), "data", "strategy-gates.json");
}

export async function readStrategyGates(): Promise<GatesFile> {
  try {
    const parsed = JSON.parse(await readFile(gatesPath(), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as GatesFile;
  } catch {
    // 没有文件 = 没有任何策略被停用，正常起步。
  }
  return {};
}

export async function writeStrategyGates(gates: GatesFile) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(gatesPath(), JSON.stringify(gates, null, 2));
}

/**
 * 单样本 t 统计量：均值 / 标准误。样本标准差（n−1 分母）。
 * 收益几乎不会逐笔独立（同涨同跌），这个 t 会偏乐观——判决往严里不靠它宽，
 * 所以可以接受。笔数太少返回 null：不判决。
 */
export function tStat(rets: number[]): number | null {
  const n = rets.length;
  if (n < 8) return null;
  const mean = rets.reduce((sum, value) => sum + value, 0) / n;
  const variance = rets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  // 全部同值（如全 0）算不出标准误，不判决。用相对阈值：浮点累加下「恒等」的
  // 序列也会留下 ~1e-17 量级的残余方差，不能拿 sd === 0 判断。
  if (!(sd > Math.abs(mean) * 1e-6 + 1e-12)) return null;
  return mean / (sd / Math.sqrt(n));
}

/** 两个交易日之间隔了多少个交易日（不含 from，含 to）。 */
export function tradingDaysBetween(from: string, to: string): number {
  if (!(from < to)) return 0;
  let count = 0;
  const cursor = new Date(`${from}T12:00:00+08:00`);
  const end = new Date(`${to}T12:00:00+08:00`);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (isTradingDay(iso)) count += 1;
  }
  return count;
}

export type GateDecision =
  | { action: "disable"; next: GateRecord; reason: string }
  | { action: "parole"; next: GateRecord; reason: string }
  | { action: "restore"; next: null; reason: string }
  | { action: "none"; next: GateRecord | null; reason: string };

/**
 * 对一套策略做一次判决。纯函数：传入该策略按平仓日排序的逐笔净收益、
 * 当前状态记录和今天日期，返回该做什么。
 */
export function evaluateGate(input: { rets: number[]; record: GateRecord | null; today: string }): GateDecision {
  const { rets, record, today } = input;
  const tail = rets.slice(-STRATEGY_GATE.window);
  const t = tail.length >= STRATEGY_GATE.window ? tStat(tail) : null;

  if (!record) {
    if (t != null && t <= STRATEGY_GATE.disableT) {
      const reason = `最近 ${STRATEGY_GATE.window} 笔已平仓、t=${t.toFixed(2)} ≤ ${STRATEGY_GATE.disableT}，判定策略失效`;
      return {
        action: "disable",
        next: { state: "disabled", since: today, cooldownDays: STRATEGY_GATE.cooldownDays, strikes: 1, reason },
        reason,
      };
    }
    return { action: "none", next: null, reason: "" };
  }

  if (record.state === "disabled") {
    const waited = tradingDaysBetween(record.since, today);
    if (waited >= record.cooldownDays) {
      const reason = `冷却 ${waited} 个交易日已满（${record.cooldownDays}），假释观察：每天限 1 只`;
      return { action: "parole", next: { ...record, state: "paroled", since: today }, reason };
    }
    return { action: "none", next: record, reason: "" };
  }

  // paroled
  if (t != null && t <= STRATEGY_GATE.disableT) {
    const cooldown = Math.min(record.cooldownDays * 2, STRATEGY_GATE.maxCooldownDays);
    const reason = `假释期间再次失效：最近 ${STRATEGY_GATE.window} 笔 t=${t.toFixed(2)} ≤ ${STRATEGY_GATE.disableT}，冷却翻倍至 ${cooldown} 个交易日`;
    return {
      action: "disable",
      next: { state: "disabled", since: today, cooldownDays: cooldown, strikes: record.strikes + 1, reason },
      reason,
    };
  }
  if (t != null && t > STRATEGY_GATE.restoreT) {
    return { action: "restore", next: null, reason: `假释样本转正：最近 ${STRATEGY_GATE.window} 笔 t=${t.toFixed(2)} > ${STRATEGY_GATE.restoreT}，恢复每天 10 只` };
  }
  return { action: "none", next: record, reason: "" };
}
