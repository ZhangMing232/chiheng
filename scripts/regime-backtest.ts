/**
 * 温度计回测（2026-11-18）：跟着温度计操作 vs 一直持有，300 天真实数据。
 *
 * 方法：温度计「进攻/观察」= 持有沪深300；「空仓」= 空仓。
 * 对比两种口径：
 *  A. 跟温度计（进攻日持有、空仓日空仓）的累计收益
 *  B. 一直持有（躺平）的累计收益
 * 如果 A 跑不赢 B，温度计没用——如实报告。
 *
 * 合法口径：信号用当日收盘后数据，操作是**次日开盘**——但 closes 只有收盘价，
 * 这里用次日收盘价近似（保守：跳空高开会让实际收益更低）。结论只作参考。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeRegime } from "../src/lib/market/regime-thermometer.ts";

async function main() {
  // 沪深300 收盘序列：从腾讯 K 线缓存（data/index-closes.json，由 early 脚本刷新）
  const closes = JSON.parse(await readFile("data/index-closes.json", "utf8")) as { date: string; close: number }[];
  console.log(`[regime-backtest] 沪深300 序列 ${closes.length} 天`);
  console.log(`[regime-backtest] 沪深300 序列 ${closes.length} 天`);

  const days = computeRegime(closes);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const allCloses = new Map(closes.map((c) => [c.date, c.close]));
  const dateList = closes.map((c) => c.date);

  let regimeEquity = 1;
  let buyHoldEquity = 1;
  let regimeInMarket = 0;
  let totalDays = 0;
  const perDay: { date: string; regime: string; regimeRet: number | null; bhRet: number }[] = [];

  for (let i = 1; i < dateList.length; i++) {
    const prev = dateList[i - 1];
    const today = dateList[i];
    const prevClose = allCloses.get(prev)!;
    const todayClose = allCloses.get(today)!;
    const ret = (todayClose / prevClose - 1) * 100;
    totalDays++;
    buyHoldEquity *= 1 + ret / 100;

    // 温度计：用**昨天**的读数决定今天是否在场（合法：收盘后才知道昨天的读数，今天开盘执行）
    const prevDay = byDate.get(prev);
    if (!prevDay) { perDay.push({ date: today, regime: "数据不足", regimeRet: null, bhRet: ret }); continue; }
    if (prevDay.regime !== "空仓") {
      regimeEquity *= 1 + ret / 100;
      regimeInMarket++;
      perDay.push({ date: today, regime: prevDay.regime, regimeRet: ret, bhRet: ret });
    } else {
      perDay.push({ date: today, regime: "空仓(昨天判定)", regimeRet: 0, bhRet: ret });
    }
  }

  const out = {
    at: new Date().toISOString(),
    span: `${dateList[1]} → ${dateList[dateList.length - 1]}`,
    totalDays,
    regimeEquityPct: (regimeEquity - 1) * 100,
    buyHoldPct: (buyHoldEquity - 1) * 100,
    regimeInMarketDays: regimeInMarket,
    /** 温度计超额（pp） */
    edgePp: (regimeEquity - buyHoldEquity) * 100,
    perDay,
  };
  await writeFile(join(process.cwd(), "data", "regime-backtest.json"), JSON.stringify(out, null, 2));

  console.log(`区间 ${out.span} | ${out.totalDays} 个交易日`);
  console.log(`  跟温度计: ${(regimeEquity - 1) * 100 > 0 ? "+" : ""}${((regimeEquity - 1) * 100).toFixed(2)}%（在场 ${regimeInMarket} 天，其余空仓）`);
  console.log(`  一直持有: ${(buyHoldEquity - 1) * 100 > 0 ? "+" : ""}${((buyHoldEquity - 1) * 100).toFixed(2)}%`);
  console.log(`  温度计超额: ${(out.edgePp).toFixed(2)}pp ${out.edgePp > 0 ? "✅ 有效" : "❌ 无效"}`);
}

await main();
