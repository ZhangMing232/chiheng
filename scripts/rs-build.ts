/**
 * 这个文件是干什么的：
 * 生成「趋势中军」RS 榜——不是看谁今天涨得多，是看谁在**多个时间尺度上都比全市场强**。
 *
 * 口径（页面上会原文印出来，别在这儿偷偷改）：
 *   原始强度 raw = 0.4×20日涨幅 + 0.3×60日 + 0.2×120日 + 0.1×250日
 *   RS 百分位 = 全市场截面的中位秩（严格小于 + 0.5×相等）/ 样本数 × 100
 *   距 250 日高点 = 最新收盘 / 近 250 日最高价 - 1
 *
 * 为什么用中位秩而不直接用涨幅排：涨幅是原始值，牛市里全涨，看涨幅分不出谁强；
 * 分位数才回答「它比全市场百分之多少的票强」。中位秩而不是「≤ 的个数」，
 * 是因为大量票涨幅长期打平时，「≤」会把它们全算成 100%（看着最强，实则无信息）。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/rs-build.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAllKlines, tradingDates } from "./lib/kline-store.ts";

const OUT = "data/history/rs";
/** 至少要有这么多根才参与排名（250 日尺度 + 余量）。 */
const MIN_BARS = 255;
/** 成交额门槛（万元）。太小的票 RS 再高也接不住钱，且容易被一笔单子拉出涨幅。 */
const MIN_AMOUNT_WAN = 20000;
const TOP = 200;

function medianRank(values: number[], v: number): number {
  let less = 0;
  let eq = 0;
  for (const x of values) {
    if (x < v) less += 1;
    else if (x === v) eq += 1;
  }
  return ((less + 0.5 * eq) / values.length) * 100;
}

function ret(closes: number[], n: number): number | null {
  if (closes.length <= n) return null;
  const now = closes[closes.length - 1];
  const past = closes[closes.length - 1 - n];
  if (!past) return null;
  return now / past - 1;
}

function main() {
  const t0 = Date.now();
  const all = loadAllKlines();
  const dates = tradingDates(all);
  const lastDate = dates[dates.length - 1];

  // 名字 / 成交额 / 市值 从行情缓存拿（不在 K 线里）
  const uni = JSON.parse(readFileSync("data/universe-cache.json", "utf8")) as {
    payload: { quotes: { id: string; name: string; amount?: number; cap?: number; pe?: number }[] };
  };
  const qById = new Map(uni.payload.quotes.map((q) => [q.id, q]));

  // 行业
  let indById = new Map<string, string>();
  try {
    // 这个文件里的 industry.json 有**两种形状**：早期写的是纯字符串，
    // 后来写成了 { code, name } 对象。上一版按 string 断言，对象原样塞进 Map，
    // 结果 rows 里 industry 变成对象、页面直接渲染 → React #31（实测 2026-11-11）。
    // 三种形态都接住，拿到名字就够用（页面只显示行业名，不显示 BK 代码）。
    const ind = JSON.parse(readFileSync("data/backtest/industry.json", "utf8")) as {
      bySymbol?: Record<string, unknown>;
    };
    for (const [id, v] of Object.entries(ind.bySymbol ?? {})) {
      const name = Array.isArray(v)
        ? typeof v[0] === "string" ? v[0] : ((v[0] as { name?: string } | undefined)?.name ?? "")
        : typeof v === "string"
          ? v
          : ((v as { name?: string } | null)?.name ?? "");
      indById.set(id, name);
    }
  } catch {
    indById = new Map();
  }

  type Row = {
    id: string;
    name: string;
    raw: number;
    r20: number;
    r60: number;
    r120: number;
    r250: number;
    fromHigh: number;
    amount: number;
    cap: number;
    industry: string;
  };

  const rows: Row[] = [];
  let stale = 0;
  for (const [id, bars] of all) {
    if (bars.length < MIN_BARS) continue;
    const tail = bars.slice(-MIN_BARS);
    // 最后一根必须就是最新交易日，否则这票停牌了，RS 拿它排没意义
    if (tail[tail.length - 1].date !== lastDate) {
      stale += 1;
      continue;
    }
    const closes = tail.map((b) => b.c);
    const r20 = ret(closes, 20);
    const r60 = ret(closes, 60);
    const r120 = ret(closes, 120);
    const r250 = ret(closes, 250);
    if (r20 == null || r60 == null || r120 == null || r250 == null) continue;
    const raw = 0.4 * r20 + 0.3 * r60 + 0.2 * r120 + 0.1 * r250;
    const high250 = Math.max(...tail.slice(-250).map((b) => b.h));
    const q = qById.get(id);
    rows.push({
      id,
      name: q?.name ?? id,
      raw,
      r20,
      r60,
      r120,
      r250,
      fromHigh: high250 > 0 ? closes[closes.length - 1] / high250 - 1 : 0,
      amount: q?.amount ?? 0,
      cap: q?.cap ?? 0,
      industry: indById.get(id) ?? "",
    });
  }

  const raws = rows.map((r) => r.raw);
  const ranked = rows
    .map((r) => ({ ...r, rs: medianRank(raws, r.raw) }))
    .filter((r) => r.amount >= MIN_AMOUNT_WAN)
    .sort((a, b) => b.rs - a.rs || b.raw - a.raw)
    .slice(0, TOP);

  const medRaw = raws.slice().sort((a, b) => a - b)[Math.floor(raws.length / 2)];

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "latest.json"),
    JSON.stringify({
      date: lastDate,
      generatedAt: new Date().toISOString(),
      universe: rows.length,
      stale,
      medianRaw: medRaw,
      minAmountWan: MIN_AMOUNT_WAN,
      weights: [0.4, 0.3, 0.2, 0.1],
      rows: ranked,
    }),
  );

  console.log(
    `[rs] ${lastDate} · 参与排名 ${rows.length} 只（停牌/未更新 ${stale} 只剔除）· 中位强度 ${(medRaw * 100).toFixed(1)}% · 上榜 ${ranked.length} 只 · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  for (const r of ranked.slice(0, 5)) {
    console.log(`  ${r.name} ${r.id} RS ${r.rs.toFixed(1)} · 20日 ${(r.r20 * 100).toFixed(0)}% · 距高点 ${(r.fromHigh * 100).toFixed(0)}%`);
  }
}

main();
