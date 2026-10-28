/**
 * 生成每日候选信号清单。
 * 收盘后跑（约 15:30），复用回测的策略函数扫全市场当日 K 线，
 * 输出所有触发信号的股票到 data/signals/candidates.json。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/generate-signals.ts
 *
 * 输出格式（每一条候选信号）：
 *   { date, id, code, name, strategy, buyPrice, score, reason }
 *
 * 注意：buyPrice 是收盘后计算的挂单价——明天竞价后还要审核。
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

// 从回测文件里直接 import 成本太大（会跑整个 main），这里精简一份 metrics
// 和策略函数出来。用最小依赖集：只要 K 线数据和东财快照代码。

interface Signal {
  id: string;
  code: string;
  name: string;
  strategy: string;
  buyPrice: number;
  score: number;
  reason: string;
}

// 先把候选信号写到临时文件
async function main() {
  console.log("信号生成：收盘后扫全市场...\n");

  // 1. 拿全市场股票列表
  const ids: string[] = [];
  const names: Record<string, string> = {};
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const list = (await res.json()) as { symbol?: string; name?: string }[];
    if (list.length === 0) break;
    for (const row of list) {
      const s = row.symbol ?? "";
      if (/^(sh|sz)\d{6}$/.test(s)) {
        ids.push(s);
        if (row.name) names[s] = row.name;
      }
    }
  }
  console.log(`股票池：${ids.length} 只`);

  // 2. 加载最新 K 线（data/backtest/kline/ 目录下最新的 JSON）
  const files = (await readdir(KLINE)).filter(f => f.endsWith(".json")).sort();
  let klineMap = new Map<string, Row[]>();
  for (const id of ids.slice(0, 3000)) {
    try {
      const raw = JSON.parse(await readFile(`${KLINE}/${id}.json`, "utf8"));
      if (!Array.isArray(raw)) continue;
      klineMap.set(id, raw as Row[]);
    } catch {}
  }
  console.log(`K 线命中：${klineMap.size} 只`);

  // 3. 策略扫描（简化版 metrics + 策略函数）
  const signals: Signal[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const [id, rows] of klineMap) {
    const i = rows.length - 1;
    if (i < 60) continue;
    const r = rows[i];
    const r1 = rows[i - 1];
    if (!r || !r1) continue;

    // 简化版 metrics：只算策略需要的几个字段
    const o = r.o, c = r.c, h = r.h, l = r.l;
    const prev = r1.c;
    const chg = prev > 0 ? (c / prev - 1) * 100 : null;
    if (chg == null || c <= 0) continue;

    /**
     * 挂单价基准 = 信号日收盘 `c`（对「明日下单」而言它就是「昨收」）。
     *
     * 2026-10-28 修：以前用 `prev`（= r1.c = 信号日**前一天**的收盘）当基准，
     * 于是显示价和线上记账用的价不是同一个——
     * 线上 `breakoutOrder` 的 `prevClose(quote)` 是 `现价/(1+涨跌幅)`，
     * 明早跑的时候取到的是信号日当天收盘。放量突破 20 日涨幅上限 10%，
     * 信号日往往已经大涨，两者能差出 3~5 个点。挂单价是给用户看的计划，
     * 必须和账本实际要挂的是同一个数。
     */
    const orderBase = c;

    // 算几个常用指标
    const win5 = rows.slice(Math.max(0, i - 4), i + 1).map(x => x.c);
    const win20 = rows.slice(Math.max(0, i - 19), i + 1).map(x => x.c);
    const win60 = rows.slice(Math.max(0, i - 59), i + 1).map(x => x.c);
    const d5 = win5[0] > 0 ? (c / win5[0] - 1) * 100 : null;
    const d20 = win20[0] > 0 ? (c / win20[0] - 1) * 100 : null;
    const d60 = win60[0] > 0 ? (c / win60[0] - 1) * 100 : null;
    const amountWan = (r.v * c) / 1e4 || 0;

    // 量比：最近5日均量
    const vols = rows.slice(Math.max(0, i - 9), i).map(x => x.v);
    const avgVol = vols.length > 0 ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    const volRatio = avgVol > 0 ? r.v / avgVol : null;

    if (d5 == null || d20 == null || d60 == null || volRatio == null) continue;

    // 放量突破
    if (volRatio >= 1.8 && d20 >= 0 && d20 <= 20 && d5 >= 0 && d5 <= 8 && chg >= 0 && chg <= 7 && c >= 4 && amountWan >= 8000) {
      const buy = orderBase * 1.02;
      signals.push({ id, code: id.slice(2), name: names[id] ?? "", strategy: "放量突破", buyPrice: +buy.toFixed(2), score: +volRatio.toFixed(1), reason: `量比${volRatio.toFixed(1)}，20日涨${d20.toFixed(0)}%` });
    }
    // 突破早期版
    if (volRatio >= 1.5 && d20 >= -3 && d20 <= 12 && d5 >= 0 && d5 <= 5 && chg >= 1 && chg <= 4 && c >= 4 && amountWan >= 5000) {
      const buy = orderBase * 1.02;
      const already = signals.find(s => s.id === id && s.strategy === "放量突破");
      if (!already) signals.push({ id, code: id.slice(2), name: names[id] ?? "", strategy: "突破·早期版", buyPrice: +buy.toFixed(2), score: +volRatio.toFixed(1), reason: `量比${volRatio.toFixed(1)}，20日涨${d20.toFixed(0)}%，今涨${chg.toFixed(1)}%` });
    }
    // 启动前期
    if (volRatio >= 1.2 && volRatio <= 2.8 && chg >= 1 && chg <= 4.5 && d5 >= 0 && d5 <= 8 && d20 >= -3 && d20 <= 12 && d60 >= -10 && d60 <= 25 && c >= 4 && amountWan >= 5000) {
      const buy = orderBase * 1.0275;
      signals.push({ id, code: id.slice(2), name: names[id] ?? "", strategy: "启动前期", buyPrice: +buy.toFixed(2), score: +volRatio.toFixed(1), reason: `20日涨${d20.toFixed(0)}%，今涨${chg.toFixed(1)}%` });
    }
  }

  console.log(`信号总数：${signals.length}`);
  for (const s of signals.slice(0, 10)) {
    console.log(`  ${s.strategy} | ${s.code} ${s.name} | 挂${s.buyPrice} | ${s.reason}`);
  }
  if (signals.length > 10) console.log(`  ... 还有 ${signals.length - 10} 条`);

  // 4. 落盘
  await mkdir(`${DATA}/signals`, { recursive: true });
  await writeFile(`${DATA}/signals/candidates.json`, JSON.stringify({ date: today, signals }, null, 2));
  console.log(`\n候选信号已保存到 ${DATA}/signals/candidates.json`);

  // ── PushPlus 推送：收盘后告诉主人今天出了多少条 ─────────────────
  if (signals.length > 0) {
    try {
      const { sendPushPlus } = await import("./alias.mjs").then(() => import("../src/lib/market/push.ts"));
      const fromCount = new Map<string, number>();
      for (const s of signals) fromCount.set(s.strategy, (fromCount.get(s.strategy) ?? 0) + 1);
      const lines = [...fromCount.entries()].map(([k, v]) => `${k}：${v} 条`);
      const sent = await sendPushPlus("赤轨信号·今日收盘", [
        `信号日：${today}`,
        `共 ${signals.length} 条候选`,
        ...lines,
        "明早 9:26 竞价审核后看可执行清单",
      ].join("\n"), "txt");
      console.log(sent ? "PushPlus 推送已发送" : "PushPlus 没推出去（看上一行的原因），候选已落盘不影响页面");
    } catch (e) {
      console.log(`PushPlus 推送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });