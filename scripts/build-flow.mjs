/**
 * 这个文件是干什么的：
 * 拉回测样本每只票的**主力净流入历史**（东财 push2his，日级），写成
 * data/backtest/flow/{code}.json，给资金流因子检验（backtest.ts 的 BT_FLOW）用。
 *
 * 为什么要单独拉：项目里 flow.ts 只有「当日实时」资金流，没有历史；要回测
 * 资金流因子，得有历史。东财 push2his 是免费源里最直接的个股日级资金流，
 * 实测本机连通。
 *
 * 已知的硬约束（别当 bug 修）：
 * 1. **历史封顶 120 个交易日**——lmt 设 300 也只回 120 条（实测首条约 2026-04）。
 *    所以资金流因子只能做短窗口探路，做不了完整 250 天的 6 关。
 * 2. **东财有风控**——串行 + 每次间隔 ≥1.2s，别开并发，否则封 IP。
 * 3. 金额单位是元；字段是「日期,主力,小单,中单,大单,超大单,主力净占比%」。
 *
 * 跑法：node scripts/build-flow.mjs
 * 增量：{code}.json 已存在就跳过，不会重复拉。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const CACHE = join(here, "data/backtest/flow");
const SAMPLE = Number(process.env.BT_SAMPLE ?? 300);
const UA = "Mozilla/5.0";

import { rateLimitOf } from "../src/lib/market/fetch-policy.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 新浪全市场快照，拿 sh/sz 六位代码（和 backtest.ts 同一份逻辑）。 */
async function universe() {
  const ids = [];
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;
    for (const row of list) {
      const s = row.symbol ?? "";
      if (/^(sh|sz)\d{6}$/.test(s)) ids.push(s);
    }
  }
  return ids;
}

/** 拉单只票的 120 日资金流。失败返回 null（不是抛，保证批量能跑完）。 */
async function fetchFlow(id) {
  const secid = `${id.startsWith("sh") ? "1" : "0"}.${id.slice(2)}`;
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get" +
    `?secid=${secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57&lmt=120`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const klines = body?.data?.klines;
  if (!Array.isArray(klines)) return null;
  const rows = [];
  for (const line of klines) {
    const p = line.split(",");
    if (p.length < 7) continue;
    const num = (v) => (v === "-" || v === "" ? 0 : Number(v));
    rows.push({
      date: p[0],
      main: num(p[1]),   // 主力净流入（元）
      small: num(p[2]),  // 小单
      mid: num(p[3]),    // 中单
      large: num(p[4]),  // 大单
      super: num(p[5]),  // 超大单
      ratio: num(p[6]),  // 主力净占比（%）
    });
  }
  return rows.length > 0 ? rows : null;
}

await mkdir(CACHE, { recursive: true });

const ids = await universe();
const step = Math.max(1, Math.floor(ids.length / SAMPLE));
// BT_OFFSET 换个起点就是另一批互不重叠的票，给 G4 换样本用（和 backtest.ts 同口径）。
const offset = Number(process.env.BT_OFFSET ?? 0);
const sample = ids.filter((_, i) => (i + offset) % step === 0).slice(0, SAMPLE);
console.log(`股票池 ${ids.length} 只，抽样 ${sample.length} 只${offset ? `（offset=${offset}）` : ""}\n`);

let ok = 0;
let skip = 0;
let fail = 0;
let empty = 0;

for (let i = 0; i < sample.length; i += 1) {
  const id = sample[i];
  const target = join(CACHE, `${id}.json`);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(target, "utf8"));
  } catch {
    cached = null;
  }
  if (Array.isArray(cached) && cached.length > 0) {
    skip += 1;
    continue;
  }
  const rows = await fetchFlow(id);
  if (rows === null) {
    fail += 1;
  } else {
    await writeFile(target, JSON.stringify(rows), "utf8");
    ok += 1;
  }
  if ((i + 1) % 25 === 0) {
    console.log(`  进度 ${i + 1}/${sample.length}（成功 ${ok} 跳过 ${skip} 失败 ${fail}）`);
  }
  await sleep(rateLimitOf("eastmoney").minGapMs); // 东财限流：串行 + 间隔查 fetch-policy.ts
}

console.log(`\n完成：成功 ${ok} · 复用缓存 ${skip} · 失败 ${fail} · 空 ${empty}`);
console.log(`缓存目录 → ${CACHE}`);
