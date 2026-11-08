/**
 * 方向 C：行业/板块轮动。用本地 data/backtest/industry-monthly.json（东财 L3，496 个板块，
 * 2025-02~2026-10 月度收盘）做横截面动量轮动：
 *   每月末按过去 L 个月收益给板块排序，挑前 K 名，持有到下月末，等权。
 * 信号是「板块相对强度」，和老六套的「个股价格形态」彻底不同。
 *
 * 判定用白皮书 §4 两道关（聚类 |t|≥2 且 前后同向）：把每个被持有的板块-月当成一笔
 * 持仓，超额 = 该板块当月收益 − 全板块等权基准当月收益，按平仓月（exitDate=月份）聚类。
 *
 * 月度轮动的「笔数」= 再平衡次数 × 持有板块数（约 14 月 × K），够过 30 笔的闸。
 * 月度收益直接由板块收盘算（close[i]/close[i-1]-1），不依赖 chgPct 的单位。
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest-sector.ts
 */
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { readFile } from "node:fs/promises";

const PATH = "data/backtest/industry-monthly.json";
const TOP_K = [5, 10, 20];
const LOOK = [3, 6];

type Board = { name: string; months: { month: string; close: number }[] };

async function main() {
  const d = JSON.parse(await readFile(PATH, "utf8")) as { boards: Record<string, Board> };
  const boards = Object.entries(d.boards);

  const mset = new Set<string>();
  for (const [, b] of boards) for (const m of b.months) if (typeof m.close === "number") mset.add(m.month);
  const months = [...mset].sort();
  const mi = new Map(months.map((m, i) => [m, i]));

  const closeMap = new Map<string, Map<string, number>>();
  for (const [code, b] of boards) {
    const m = new Map<string, number>();
    for (const x of b.months) if (typeof x.close === "number") m.set(x.month, x.close);
    closeMap.set(code, m);
  }

  // 板块月度收益
  const retMap = new Map<string, Map<string, number>>();
  for (const [code, m] of closeMap) {
    const rm = new Map<string, number>();
    for (let i = 1; i < months.length; i += 1) {
      const c0 = m.get(months[i - 1]);
      const c1 = m.get(months[i]);
      if (c0 && c1 && c0 > 0) rm.set(months[i], c1 / c0 - 1);
    }
    retMap.set(code, rm);
  }

  // 全板块等权基准（每月）
  const benchByMonth = new Map<string, number>();
  for (const cur of months) {
    const vals: number[] = [];
    for (const [, rm] of retMap) {
      const r = rm.get(cur);
      if (r != null) vals.push(r);
    }
    benchByMonth.set(cur, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  }

  console.log(`行业轮动回测：板块数 ${boards.length}，月份 ${months[0]}~${months[months.length - 1]}（${months.length} 个月）`);
  console.log("L(动量月) K(持有数)  组合总收益  基准总收益  笔数   信噪比   前后半段   两道关判定");
  console.log("-".repeat(86));

  for (const L of LOOK) {
    for (const K of TOP_K) {
      const trades: { ret: number; bench: number; exitDate: string }[] = [];
      let wealth = 1;
      let benchWealth = 1;
      for (let i = L; i < months.length - 1; i += 1) {
        const cur = months[i];
        const lookBack = months[i - L];
        const scored: { code: string; mom: number }[] = [];
        for (const [code, m] of closeMap) {
          const c0 = m.get(lookBack);
          const c1 = m.get(cur);
          if (c0 && c1 && c0 > 0) scored.push({ code, mom: c1 / c0 - 1 });
        }
        scored.sort((a, b) => b.mom - a.mom);
        const held = scored.slice(0, Math.min(K, scored.length)).map((s) => s.code);
        const fwd = months[i + 1];
        const fwdRets = held
          .map((code) => retMap.get(code)?.get(fwd))
          .filter((r): r is number => r != null);
        if (fwdRets.length === 0) continue;
        const portRet = fwdRets.reduce((a, b) => a + b, 0) / fwdRets.length;
        const benchRet = benchByMonth.get(fwd) ?? 0;
        wealth *= 1 + portRet;
        benchWealth *= 1 + benchRet;
        for (const r of fwdRets) trades.push({ ret: r, bench: benchRet, exitDate: fwd });
      }
      const cg = clusterTOf(trades);
      const hs = halvesSameSignOf(trades);
      const v = judgeGenomeVerdict({
        ran: true,
        trades: trades.length,
        excessPp: cg ? cg.excess * 100 : null,
        clusteredT: cg ? cg.clusterT : null,
        halvesSameSign: hs,
      });
      const tStr = cg && cg.clusterT != null ? (cg.clusterT >= 0 ? "+" : "") + cg.clusterT.toFixed(2) : "算不出";
      const hsStr = hs == null ? "?" : hs ? "同向✓" : "翻脸✗";
      const verdict = v.status === "promoted" ? "过关 ✓" : v.status === "rejected" ? "没过 ✗" : "样本不足";
      console.log(
        `${String(L).padEnd(9)}${String(K).padEnd(10)}` +
          `${((wealth - 1) * 100).toFixed(0).padStart(8)}%` +
          `${((benchWealth - 1) * 100).toFixed(0).padStart(10)}%` +
          `${String(trades.length).padStart(6)}` +
          tStr.padStart(8) +
          hsStr.padStart(8) +
          verdict.padStart(10),
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
