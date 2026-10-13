/**
 * 这个文件是干什么的：
 * 钉住回测指标——**数据不够返回 null 不返回 0**、**回撤从起始资金起算**、
 * **盈亏按扣费后**。
 *
 * 三条各对应一个真实错误：
 * 1. 返回 0 会被读成「不赚不亏」，其实是没答案（夏普样本不足、sortino 没有下行波动）。
 * 2. 只用观测权益算回撤会低估第一根亏损，权益跌穿 0 后回撤变得没有意义。
 * 3. 用毛盈亏算胜率会把费用藏起来——回测的意义就是看扣费后还剩多少。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { annualizedReturn, calmar, maxDrawdown, sharpe, sortino, tradeStats } from "@/lib/market/metrics";

test("sharpe：有波动的正收益 → 正值；恒定收益 → null（std=0 无定义）", () => {
  // 交替 2%/0.5%：均值正、有波动 → 夏普为正
  const wavy = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.02 : 0.005));
  assert.ok((sharpe(wavy) as number) > 1);
  // 恒定收益 std=0，夏普无定义——返回 null 而不是 0
  assert.equal(sharpe(Array.from({ length: 30 }, () => 0.01)), null, "恒定序列 std=0，没夏普");
  assert.equal(sharpe(Array.from({ length: 30 }, () => 0)), null, "平的序列给 null 不给 0");
});

test("sharpe 年化用 √barsPerYear", () => {
  const r = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.02 : 0.005));
  const s = sharpe(r)!;
  const sCrypto = sharpe(r, 365)!;
  assert.ok(sCrypto > s, "年化因子越大夏普越高");
});

test("sortino：没有下行波动 → null（分母 0 不硬算）", () => {
  assert.equal(sortino(Array.from({ length: 30 }, () => 0.01)), null);
  const mixed = [0.02, -0.01, 0.03, -0.02, 0.01, -0.01];
  assert.ok((sortino(mixed) as number) > 0);
});

test("最大回撤从起始资金起算（第一根就亏也要算）", () => {
  // 起始 100，第一根直接到 80 → 回撤 20%
  const dd = maxDrawdown([80, 90, 85], 100);
  assert.ok(Math.abs(dd - 0.2) < 1e-9, `实际 ${dd}`);
});

test("最大回撤：不用 initialCash 就会低估", () => {
  const equity = [80, 90, 85];
  const naive = Math.max(...equity);
  const naiveDd = (naive - Math.min(...equity)) / naive; // 只看观测值：(90-80)/90 ≈ 11%
  assert.ok(naiveDd < 0.2, `naive 只算出 ${(naiveDd * 100).toFixed(1)}%`);
  assert.ok(Math.abs(maxDrawdown(equity, 100) - 0.2) < 1e-9, "从 100 起算才是 20%");
});

test("calmar：回撤 ≈ 0 → null", () => {
  assert.equal(calmar([100, 101, 102], 100), null);
  assert.ok((calmar([100, 120, 90, 110], 100) as number) != null);
});

test("tradeStats：胜率/盈亏比/连亏/持仓/profit factor 都按扣费后", () => {
  const trades = [
    { netPnl: 100, holdingBars: 5 },
    { netPnl: -50, holdingBars: 3 },
    { netPnl: 200, holdingBars: 10 },
    { netPnl: -30, holdingBars: 2 },
    { netPnl: -20, holdingBars: 4 },
  ];
  const s = tradeStats(trades);
  assert.equal(s.n, 5);
  assert.ok(Math.abs(s.winRate! - 2 / 5) < 1e-9);
  assert.equal(s.maxConsecutiveLoss, 2, "末尾两连亏");
  assert.equal(s.avgHoldingBars, (5 + 3 + 10 + 2 + 4) / 5);
  assert.ok(Math.abs(s.profitFactor! - 300 / 100) < 1e-9, "总盈利300/总亏损100");
});

test("没有交易 → 全 null，不补 0", () => {
  const s = tradeStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.profitFactor, null);
});

test("没有亏损单 → profitFactor null（分母 0）", () => {
  const s = tradeStats([{ netPnl: 100, holdingBars: 5 }, { netPnl: 50, holdingBars: 3 }]);
  assert.equal(s.profitFactor, null);
});

test("年化收益：权益跌穿 0 → null（几何年化没意义）", () => {
  assert.equal(annualizedReturn([100, 50, 0], 100), null);
  assert.ok((annualizedReturn([100, 110, 121], 100) as number) > 0);
});
