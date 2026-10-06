/**
 * 这个文件是干什么的：
 * 把券商真实持仓和账本推导的持仓逐只比对，找出不一致。
 *
 * 为什么必须有这个：
 * 现在持仓纯从账本推导（positions.ts 从 trades 算出来），**没有任何东西会去问
 * 券商「你那边到底有哪些票」。** 那种系统一旦接上真钱，账本和券商对不上时
 * 没人知道——策略以为它持有某只票在算收益，实际上早卖掉了。
 * 收益是错的，风险敞口是看不见的。
 *
 * 纯函数，能搬进小程序，能测。
 *
 * 三条原则：
 * 1. **只报告，不自动改账本。** 自动改会把不该归因的持仓算进策略收益
 *    （比如你在客户端手动下的单，被系统当成策略开的仓）。
 * 2. **成本价的差异不算异常。** 券商的 avgPrice 含佣金印花税，
 *    和账本的买入价天然差千分之几，容忍度按比例算。
 * 3. **「和 0 区分不开」不等于「有差异」。** 数量差得少、金额差得小，
 *    如果小于容忍度就报出来让人看，不当成事故。
 */

import type { BrokerPosition } from "./orders.ts";

/** 账本这边的一笔持仓（可能有多笔同票，所以带 lotId）。 */
export type LedgerLot = {
  lotId: string;
  code: string;
  /** 原始数量 */
  volume: number;
  /** 还没卖掉的 */
  remaining: number;
  entry: number;
};

export type Diff =
  | { kind: "broker_only"; code: string; volume: number }
  | { kind: "ledger_only"; code: string; volume: number }
  | { kind: "volume_mismatch"; code: string; broker: number; ledger: number; delta: number }
  | { kind: "avg_price_drift"; code: string; broker: number; ledger: number; tolerance: number };

/** 成本价容忍度。券商的 avgPrice 含费用，差千分之几很正常。 */
export const AVG_PRICE_TOLERANCE = 0.005;

export type ReconcileResult = {
  diffs: Diff[];
  /**
   * 要不要挡住今天的新开仓。
   * 数量对不上是硬问题（不知道手里到底有什么）→ 挡。
   * 只有成本价漂移 → 不挡，只提示。
   */
  blocking: boolean;
};

/**
 * 逐只比对。
 *
 * 账本这边要先按 code 汇总——多笔同票（分批建仓）应该合并成一个总数再比，
 * 否则会拿 300 股和 100 股比然后报「不一致」，那是假的。
 */
export function diffPositions(
  broker: BrokerPosition[],
  ledger: LedgerLot[],
  options: { tolerance?: number; comparePrice?: boolean } = {},
): ReconcileResult {
  const tolerance = options.tolerance ?? AVG_PRICE_TOLERANCE;
  const comparePrice = options.comparePrice ?? true;

  const brokerByCode = new Map<string, BrokerPosition>();
  for (const row of broker) {
    if (!(row.volume > 0)) continue; // 券商返回 0 持仓的票不算「券商有」
    brokerByCode.set(row.code, row);
  }

  const ledgerByCode = new Map<string, { volume: number; cost: number }>();
  for (const lot of ledger) {
    if (!(lot.remaining > 0)) continue; // 全卖掉的 lot 不算
    const cur = ledgerByCode.get(lot.code);
    if (cur) {
      // 成本用加权平均，和券商口径一致
      const total = cur.volume + lot.remaining;
      cur.cost = (cur.cost * cur.volume + lot.entry * lot.remaining) / total;
      cur.volume = total;
    } else {
      ledgerByCode.set(lot.code, { volume: lot.remaining, cost: lot.entry });
    }
  }

  const codes = new Set<string>([...brokerByCode.keys(), ...ledgerByCode.keys()]);
  const diffs: Diff[] = [];

  for (const code of codes) {
    const b = brokerByCode.get(code);
    const l = ledgerByCode.get(code);
    if (b && !l) {
      diffs.push({ kind: "broker_only", code, volume: b.volume });
      continue;
    }
    if (!b && l) {
      diffs.push({ kind: "ledger_only", code, volume: l.volume });
      continue;
    }
    if (!b || !l) continue;
    if (b.volume !== l.volume) {
      diffs.push({ kind: "volume_mismatch", code, broker: b.volume, ledger: l.volume, delta: b.volume - l.volume });
      continue; // 数量都��一样了，价格比了也没意义
    }
    if (comparePrice && l.volume > 0) {
      const drift = Math.abs(b.avgPrice - l.cost) / Math.max(l.cost, 0.01);
      if (drift > tolerance) {
        diffs.push({ kind: "avg_price_drift", code, broker: b.avgPrice, ledger: l.cost, tolerance });
      }
    }
  }

  // 数量不一致 = 硬问题；只有价格漂移 = 提示
  const blocking = diffs.some((d) => d.kind !== "avg_price_drift");
  return { diffs, blocking };
}

/** 人话。日志和界面上都直接用这个，别各编一套说法。 */
export function describeDiff(diff: Diff): string {
  switch (diff.kind) {
    case "broker_only":
      return `券商有 ${diff.volume} 股、账本没有（可能在客户端手动下过单）`;
    case "ledger_only":
      return `账本记着 ${diff.volume} 股、券商没有（漏单或账本记错）`;
    case "volume_mismatch":
      return `数量不一致：券商 ${diff.broker} 股，账本 ${diff.ledger} 股，差 ${diff.delta} 股`;
    case "avg_price_drift":
      return `成本价漂移：券商 ${diff.broker.toFixed(3)}，账本 ${diff.ledger.toFixed(3)}，超过 ${(diff.tolerance * 100).toFixed(1)}%`;
  }
}

/**
 * 账本 → LedgerLot[]。实盘路径用它把 trades 转成对账需要的形状。
 * 模拟盘的 trades 没有 lotId，用 code 当 lotId（一只票只有一笔时够用）。
 */
export function lotsFromTrades(
  days: { trades: { id: string; entry: number; exit: number | null; lotId?: string }[] }[],
  volumeOf: (trade: { id: string; lotId?: string }) => number,
): LedgerLot[] {
  const out: LedgerLot[] = [];
  for (const day of days) {
    for (const trade of day.trades) {
      out.push({
        lotId: trade.lotId ?? trade.id,
        code: trade.id,
        volume: volumeOf(trade),
        // 没卖掉的才算账本上的持仓
        remaining: trade.exit == null ? volumeOf(trade) : 0,
        entry: trade.entry,
      });
    }
  }
  return out;
}
