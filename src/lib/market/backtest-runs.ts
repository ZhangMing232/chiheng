/**
 * 这个文件是干什么的：
 * 回测运行记录的类型和读取层（页面 /backtest 读它）。
 *
 * 为什么要落这份数据：回测结果原来只 print 到 stdout，要存就人工把输出复制成
 * `baseline-*.txt`。人存的 txt 没法比较、没法画曲线、页面也读不了。所以让脚本
 * **顺手多落一份 JSONL**：一次运行一行，含环境参数（区间、撮合口径、费用、闸口）
 * 和每套策略的指标。txt 继续留着（它是人读的完整报告），JSONL 是给机器读的。
 *
 * 你需要知道的：
 * 1. **一行 = 一次运行**，不是一次策略。同一批策略的结果必须在同一行里，
 *    拆开就分不清哪次跑的是哪套口径了。
 * 2. **环境参数和数字一样重要**。成本口径改过一次（0.102% → 0.302%），旧数字
 *    全部失效——所以每行都带 `env`，页面把 env 摊开显示，别让人拿不同口径的数字
 *    直接比大小。
 * 3. **只追加不改**（JSONL）。跑一次加一行，跑坏了那行就难看，但历史不会被改。
 * 4. 读取时校验：结构不对的行**跳过并打日志**，不整份报废。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 一套策略在一次运行里的指标。比率都是 0-1 的小数（页面负责 ×100 显示）。 */
export type BacktestStyleStat = {
  /** 策略内部 key（如 rebound） */
  key: string;
  label: string;
  trades: number;
  /** 胜率 0-1 */
  winRate: number;
  /** 单笔平均收益（小数） */
  avgRet: number;
  /** 同期全池等权基准（小数） */
  benchAvg: number;
  /** 超额 = avgRet − benchAvg */
  alpha: number;
  /** 超额的 t 值。|t| < 2 等于没测出来 */
  tStat: number;
  /** 跑赢基准的笔数占比 0-1 */
  beatRate: number;
  /** 平均持有交易日 */
  avgHold: number;
  /** 最长连亏天数（按天算） */
  worstStreak: number;
  /** 按天算的回撤（小数） */
  drawdown: number;
};

/** 跑这次的环境。不同口径的数字不能直接比，所以这些必须跟着数字一起存。 */
export type BacktestEnv = {
  /** 回测区间起止 */
  start: string;
  end: string;
  /** 区间交易日数 */
  days: number;
  /** 抽了多少只股票 */
  sample: number;
  /** 实际取到日线的只数 */
  covered: number;
  /** 入场撮合口径 a=按挂单价 b=按真实成交（跳空按开盘） */
  fillMode: string;
  /** 一来一回的费用（小数，含滑点） */
  fee: number;
  /** 换手率闸是否生效 */
  turnoverGate: boolean;
  /** 止损百分比（跑批覆盖时记下来） */
  stopPct: number | null;
  /** 同期沪深300买入持有（小数） */
  bench300: number;
};

export type BacktestRun = {
  /** 跑完的时刻（ISO） */
  ranAt: string;
  /** 上海时区的日期（YYYY-MM-DD），页面上按天分组用 */
  ranDate: string;
  env: BacktestEnv;
  styles: BacktestStyleStat[];
  /** 一句话说明这次跑的是什么（扫参？半区间？），可空 */
  note: string | null;
};

export const RUNS_PATH = join("data", "backtest", "runs.jsonl");

/** 校验一行。返回 null 表示这行不能用（调用方跳过并记日志）。 */
export function checkBacktestRun(value: unknown): BacktestRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<BacktestRun>;
  if (typeof v.ranAt !== "string" || typeof v.ranDate !== "string") return null;
  if (!v.env || typeof v.env !== "object") return null;
  const env = v.env as Partial<BacktestEnv>;
  if (typeof env.start !== "string" || typeof env.end !== "string" || typeof env.fee !== "number") return null;
  if (!Array.isArray(v.styles) || v.styles.length === 0) return null;
  for (const s of v.styles) {
    const row = s as Partial<BacktestStyleStat>;
    if (typeof row?.key !== "string" || typeof row.trades !== "number") return null;
  }
  return v as BacktestRun;
}

/**
 * 读全部运行记录，新的在前。
 * 坏行跳过并打日志——历史文件只追加不改，坏行说明某次跑崩了，不该让整份报废。
 */
export async function loadBacktestRuns(root = process.cwd(), limit = 60): Promise<{ runs: BacktestRun[]; bad: number }> {
  let text: string;
  try {
    text = await readFile(join(root, RUNS_PATH), "utf-8");
  } catch {
    return { runs: [], bad: 0 };
  }
  const runs: BacktestRun[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const run = checkBacktestRun(JSON.parse(trimmed));
      if (run) runs.push(run);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) console.error(`[backtest] ${RUNS_PATH} 有 ${bad} 行读不出来，已跳过（某次运行崩了会这样）`);
  runs.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  return { runs: runs.slice(0, limit), bad };
}