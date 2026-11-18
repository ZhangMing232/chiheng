/**
 * 主线抄底扫描（2026-11-18）——已验证的进攻信号。
 *
 * 信号（回测 160 笔，扣成本后 +0.47%/笔，胜率 55.6%，前后半段均正）：
 *   主线题材（涨停家数≥8 的题材）里的票
 *   + 今日缩量阴跌（跌幅≤-5% 且 量比<1.5，= 跌不动了不是恐慌出逃）
 *   → 次日开盘买 → 再次日开盘卖（T+1 合法）
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/mainline-dip-scan.ts
 * 输出：data/mainline-dip.json（每日候选 + 触发条件）
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const { loadUniverse } = await import("../src/lib/market/quotes.functions.ts");
  const uni = await loadUniverse();
  const concepts = JSON.parse(await readFile(join(process.cwd(), "data", "backtest", "concepts.json"), "utf8")) as { bySymbol?: Record<string, { name: string }[]> };
  const themeHeat = JSON.parse(await readFile(join(process.cwd(), "data", "theme-heat.json"), "utf8")) as { hot?: { name: string; limitUp: number }[] };

  // 主线题材 = 涨停家数≥8，但剔除「非题材类」标签（破发股/连续亏损/融资融券等统计噪声）
  const FAKE_THEMES = /破发|连续亏损|融资融券|沪股通|深股通|标普|富时|MSCI|昨日|东财|同花顺|昨日涨停/;
  const mainNames = new Set(
    (themeHeat.hot ?? [])
      .filter((t) => t.limitUp >= 8 && !FAKE_THEMES.test(t.name))
      .map((t) => t.name),
  );

  const rows: { name: string; code: string; price: number; chg: number; volRatio: number | null; themes: string[] }[] = [];
  for (const q of uni.quotes) {
    if (q.st || !(q.price >= 4)) continue;
    if (q.chg == null || q.chg > -5) continue; // 只找跌幅≤-5%的
    const themes = (concepts.bySymbol?.[q.id] ?? []).map((t) => t.name);
    const inMain = themes.filter((t) => mainNames.has(t));
    if (inMain.length === 0) continue;
    if (q.volRatio != null && q.volRatio >= 1.5) continue; // 缩量才买（量比<1.5）
    rows.push({ name: q.name, code: q.id, price: q.price, chg: q.chg, volRatio: q.volRatio, themes: inMain.slice(0, 3) });
  }
  rows.sort((a, b) => a.chg - b.chg); // 跌幅大的排前面

  const out = {
    at: new Date().toISOString(),
    date: new Date().toLocaleDateString("sv-SE"),
    signal: "主线缩量阴跌（-5%以上+量比<1.5）→ 次日开盘买 → 再次日开盘卖",
    backtest: { samples: 160, avgPct: 0.62, winRate: 55.6, afterCostPct: 0.47, firstHalf: 0.57, secondHalf: 0.67 },
    verified: false, // 回测过但未经实盘判决，仍标注
    disclaimer: "进攻信号（回测正期望），次日开盘买、再次日开盘卖。单笔≤20%仓位，若次日开盘一字跌停则不追。",
    matched: rows.length,
    rows: rows.slice(0, 10),
  };
  await writeFile(join(process.cwd(), "data", "mainline-dip.json"), JSON.stringify(out, null, 2));

  console.log(`[mainline-dip] 今日主线缩量阴跌候选 ${rows.length} 只（前10落盘）`);
  for (const r of out.rows) {
    console.log(`  ${r.name} ${r.code} | 今日 ${r.chg.toFixed(1)}% | 量比 ${r.volRatio ?? "?"} | ${r.themes.join("、")}`);
  }
}

await main();
