/**
 * 全量异动特征回测（2026-11-18）——小账户翻倍引擎的信号层。
 *
 * 目标：用全市场 ~5000 只 × 120 日 K 线，测各类「操纵/吸筹痕迹」在
 * **合法口径**（T+1 开盘买 → T+2 卖，扣成本）下的真实正期望。
 *
 * 为什么是这一步：翻倍靠复利 = 稳定正期望 × 高频 × 控回撤。前几轮抽样
 * 测到「放量但涨幅小」+0.5pp 超额但样本不够、前后半不稳定。全量才能
 * 算出真实的 t 值、胜率、分时段稳定性——过得了判决标准才敢用。
 *
 * 合法口径（强制，见 backtest-legality.ts）：
 *   - 买入用信号日之后第一个交易日开盘价（信号日收盘买 = 未来函数，禁止）
 *   - 卖出至少隔一日（T+1 禁止当日买卖）
 *   - 扣 ROUND_TRIP_COST_PCT
 *   - 一字板买不进剔除
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/full-edge-scan.ts [限速ms] [起始偏移]
 * 输出：data/full-edge-scan.json（结果追加，可断点续跑）
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { legalReturn, limitUpSealed, ROUND_TRIP_COST_PCT, type LegalBar } from "../src/lib/market/backtest-legality.ts";

const RATE_LIMIT_MS = Number(process.argv[2] ?? 150); // 每只票之间的间隔，避免顶 WAF
const START_OFFSET = Number(process.argv[3] ?? 0);

/** 特征签名：给定 bar 序列 + 位置 i，判断命中哪些痕迹 */
type FeatureHit = {
  A: boolean; // 缩量后放量（20日均量×2）
  B: boolean; // 放量但涨幅小（量比>2，涨幅-1~3%）
  C: boolean; // 长下影线（下影>实体2倍）
  D: boolean; // 连涨3天+放量
};

function detect(bars: LegalBar[], i: number): FeatureHit {
  const b = bars[i];
  const prev = bars[i - 1];
  const ma20v = bars.slice(Math.max(0, i - 20), i).reduce((a, x) => a + ((x as never as { v?: number }).v ?? 0), 0) / 20;
  const ma5v = bars.slice(Math.max(0, i - 5), i).reduce((a, x) => a + ((x as never as { v?: number }).v ?? 0), 0) / 5;
  const v = (b as never as { v?: number }).v ?? 0;
  const volRatio = ma20v > 0 ? v / ma20v : 0;
  const chg = prev.c > 0 ? (b.c / prev.c - 1) * 100 : 0;
  const body = Math.abs(b.c - b.o);
  const lower = Math.min(b.o, b.c) - b.l;
  const c1 = bars[i - 1]?.c ? (bars[i].c / bars[i - 1].c - 1) * 100 : 0;
  const c2 = bars[i - 2]?.c ? (bars[i - 1].c / bars[i - 2].c - 1) * 100 : 0;
  const c3 = bars[i - 3]?.c ? (bars[i - 2].c / bars[i - 3].c - 1) * 100 : 0;

  return {
    A: volRatio > 2 && ma5v > 0 && v / ma5v > 1.5,
    B: volRatio > 2 && chg > -1 && chg < 3,
    C: body > 0 && lower > body * 2 && chg > -2,
    D: c1 > 0 && c2 > 0 && c3 > 0 && volRatio > 1.3,
  };
}

async function main() {
  const { loadUniverse } = await import("../src/lib/market/quotes.functions.ts");
  const uni = await loadUniverse();
  const pool = uni.quotes.filter((q) => q.price > 4 && q.amount > 5000);
  console.log(`[full-edge] 股票池 ${pool.length} 只，限速 ${RATE_LIMIT_MS}ms，偏移 ${START_OFFSET}`);

  // 累计各特征的正期望收益（合法口径）
  const acc = {
    A: [] as number[], B: [] as number[], C: [] as number[], D: [] as number[],
    base: [] as number[], // 全样本基准（同票同日，用于算超额）
  };
  let processed = 0;
  let totalSignals = 0;

  for (let si = START_OFFSET; si < pool.length; si++) {
    const q = pool[si];
    try {
      const { loadKline } = await import("../src/lib/market/quotes.functions.ts");
      const kl = await loadKline(q.id);
      const bars = kl.bars
        .filter((b) => b.o > 0 && b.c > 0 && (b as never as { v?: number }).v > 0)
        .map((b) => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, v: (b as never as { v?: number }).v ?? 0 })) as (LegalBar & { v: number })[];
      if (bars.length < 70) continue;

      for (let i = 60; i < bars.length - 3; i++) {
        const b = bars[i];
        const hit = detect(bars, i);
        // 只有命中任一特征才算信号，否则跳过（控制计算量）
        if (!(hit.A || hit.B || hit.C || hit.D)) continue;

        // 合法收益：T+1 开盘买 → T+2 开盘卖
        const sigDate = b.date;
        const sigIdx = bars.findIndex((x) => x.date === sigDate);
        const buy = bars[sigIdx + 1];
        if (!buy || !(buy.o > 0)) continue;
        // 一字板买不进
        if (limitUpSealed(buy, b.c)) continue;
        const r = legalReturn(sigDate, bars, 1, "open");
        if (!("pct" in r) || r.pct == null) continue;
        const ret = r.pct - ROUND_TRIP_COST_PCT;
        totalSignals++;
        if (hit.A) acc.A.push(ret);
        if (hit.B) acc.B.push(ret);
        if (hit.C) acc.C.push(ret);
        if (hit.D) acc.D.push(ret);
        acc.base.push(ret);
      }
      processed++;
      if (processed % 100 === 0) {
        console.log(`[full-edge] 进度 ${processed}/${pool.length}，累计信号 ${totalSignals}`);
        // 每 100 只落盘一次（断点续跑）
        await writeFile(
          join(process.cwd(), "data", "full-edge-scan.json"),
          JSON.stringify({ at: new Date().toISOString(), processed, totalSignals, acc }, null, 2),
        );
      }
      await new Promise((res) => setTimeout(res, RATE_LIMIT_MS));
    } catch {
      /* 单只失败跳过 */
    }
  }

  const stat = (arr: number[]) => {
    if (!arr.length) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const win = arr.filter((x) => x > 0).length / arr.length;
    // t 值（相对零）
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
    const t = sd > 0 ? m / (sd / Math.sqrt(arr.length)) : null;
    return { n: arr.length, mean: m, winRate: win, t };
  };

  const base = stat(acc.base);
  const out = {
    at: new Date().toISOString(),
    legality: "T+1开盘买→T+2开盘卖，扣成本 0.15%，一字板剔除，未来函数/T+1违规由代码强制禁止",
    processed,
    totalSignals,
    base,
    A_缩量后放量: stat(acc.A),
    B_放量但涨幅小: stat(acc.B),
    C_长下影线: stat(acc.C),
    D_连涨3天放量: stat(acc.D),
  };
  await writeFile(join(process.cwd(), "data", "full-edge-scan.json"), JSON.stringify(out, null, 2));

  console.log("\n[full-edge] 完成");
  console.log("  基准:", base ? `${base.mean.toFixed(3)}% (n=${base.n})` : "无");
  for (const [k, s] of Object.entries({ A_缩量后放量: out.A_缩量后放量, B_放量但涨幅小: out.B_放量但涨幅小, C_长下影线: out.C_长下影线, D_连涨3天放量: out.D_连涨3天放量 })) {
    if (s) console.log(`  ${k}: ${s.mean.toFixed(3)}% (n=${s.n}, 胜率${(s.winRate * 100).toFixed(1)}%, t=${s.t?.toFixed(2)})`);
  }
}

await main();
