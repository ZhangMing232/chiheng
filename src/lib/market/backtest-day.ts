/**
 * 按天聚合：一天里平仓的多笔交易，合成「那一天的组合收益」。
 *
 * 2026-10-24 从 scripts/backtest.ts 的 main() 里提出来。提的原因不是爱整洁——
 * 这三个函数身上刚出了一个活了 10 天的 bug（518e6c3，10-14 引入，10-24 才发现）：
 * 注释写着「按卖出日聚合」，代码却是 bucket.get(t.exitDate) 之后
 * bucket.set(t.date, row)——用信号日存、用卖出日取。因为卖出日恒大于信号日，
 * 而先写进 Map 的 key 全是更早的信号日，get 永远打不中，结果每个信号日只剩
 * 当天最后一笔，同一天十笔互相覆盖。runs.jsonl 里中期反转 2257 笔的 daily
 * 只剩 248 条、每条 n=1，/backtest 页四张图从 10-14 起画的就是这个。
 * 连亏天数和回撤两列同源，一并是错的。
 *
 * 而它们是 main() 的内部函数，写不了单测——bug 因此能活 10 天没人拦。
 * 提成模块 + 守门测试，下次再犯直接红。
 *
 * 口径（三处共用，改一处三处都变，别在这里搞分叉）：
 *   1. 聚合 key 是**卖出日** exitDate：收益是卖出日落袋的。按信号日聚合会把
 *      还没实现的收益算到信号日（10-14 实测：中期反转 248 天总累计因此算出
 *      -139.9%，按平均收益该是 -7.4%，差 20 倍）。
 *   2. 同一天多笔取**等权平均**不是总和：一天卖出十笔不等于十个满仓，
 *      组合当日收益是十个小仓位的平均。按总和算一天能出 +244%。
 *   3. 结果按日期升序：连亏天数要数「连续几天」，回撤要按天复利，
 *      乱序等于把收益算错日子。
 */

export type DayTrade = {
  /** 信号日（t 日收盘后选股） */
  date: string;
  /** 卖出日（收益真正落袋那天）——聚合按它，不按 date */
  exitDate: string;
  /** 这笔的收益率（已扣费） */
  ret: number;
  /** 同一时间段全池等权的收益（超额曲线用） */
  bench: number;
};

export type DayRow = { date: string; ret: number; n: number };

/** 三处共用的桶：按 exitDate 合并，value 取 pick(trade)，输出按日期升序。 */
function bucketByExitDay(trades: DayTrade[], pick: (t: DayTrade) => number): DayRow[] {
  const bucket = new Map<string, { sum: number; n: number }>();
  for (const t of trades) {
    const row = bucket.get(t.exitDate) ?? { sum: 0, n: 0 };
    row.sum += pick(t);
    row.n += 1;
    bucket.set(t.exitDate, row);
  }
  return [...bucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, row]) => ({ date, ret: row.sum / row.n, n: row.n }));
}

/**
 * 每天一个数：那天平仓的所有仓位的平均收益率。
 * 给连亏天数（streakStats）和按天回撤（drawdownByDay）用——这两个都要「天」的顺序。
 */
export function byDay(trades: DayTrade[]): number[] {
  return bucketByExitDay(trades, (t) => t.ret).map((row) => row.ret);
}

/** 落盘日度序列：平仓日 → 平均收益 + 笔数。/backtest 页四张图（累计/回撤/月度/年度）吃它。 */
export function dayRowsOf(trades: DayTrade[]): DayRow[] {
  return bucketByExitDay(trades, (t) => t.ret);
}

/** 同日期的基准（同期全池）平均，给超额曲线用。 */
export function benchRowsOf(trades: DayTrade[]): DayRow[] {
  return bucketByExitDay(trades, (t) => t.bench);
}
