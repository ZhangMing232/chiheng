/**
 * 收盘后全量刷新 K 线缓存（data/backtest/kline/<id>.json）。
 *
 * 为什么单独一个脚本：generate-signals.ts 只**读**缓存不刷，而缓存只在回测运行时
 * 被懒刷新、且每天 15:00 的 AI 进化回测只抽样 BT_SAMPLE=300 只。于是缓存停在
 * 「上一次有人手动跑全池回测」的那天（2026-10-29 实测停在 10-28，全天只有 1 个
 * 文件被刷），导致当天信号用前一天的收盘价算出来——等于漏一天信号。
 *
 * 本脚本在 15:10（收盘 10 分钟后，腾讯日线已落定）把全市场 K 线补齐到最新交易日，
 * 让 15:30 的 generate-signals 读到的是当天收盘。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/refresh-kline.ts
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;
const LOOKBACK = 250;
const WORKERS = 8;

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

const KLINE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://gu.qq.com/",
};

/** 腾讯前复权日线（和 backtest.ts 的 fetchKline 同源同口径）。 */
async function fetchKline(id: string): Promise<Row[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,${LOOKBACK + 80},qfq`;
  const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
  const rows = body.data?.[id]?.qfqday ?? body.data?.[id]?.day ?? [];
  const out: Row[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const o = Number(r[1]);
    const c = Number(r[2]);
    const h = Number(r[3]);
    const l = Number(r[4]);
    const v = Number(r[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    out.push({ date: r[0], o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

/** 用沪深 300 指数当「最新交易日」尺子。收盘 10 分钟后日线已落定。 */
async function latestTradingDay(): Promise<string> {
  const rows = await fetchKline("sh000300");
  const last = rows[rows.length - 1];
  return last?.date ?? new Date().toISOString().slice(0, 10);
}

async function main() {
  console.log("K 线全量刷新开始...\n");

  // 1. 拿全市场股票列表（和 generate-signals 同源）
  const ids: string[] = [];
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const list = (await res.json()) as { symbol?: string }[];
    if (list.length === 0) break;
    for (const row of list) {
      const s = row.symbol ?? "";
      if (/^(sh|sz)\d{6}$/.test(s)) ids.push(s);
    }
  }
  console.log(`股票池：${ids.length} 只`);

  // 2. 最新交易日尺子
  const anchor = await latestTradingDay();
  console.log(`最新交易日（沪深300 末根）：${anchor}\n`);

  // 3. 并发刷新：最后 K 线早于 anchor 的（或缺失的）重抓并写回
  await mkdir(KLINE, { recursive: true });
  let refreshed = 0;
  let upToDate = 0;
  let failed = 0;
  const queue = [...ids];

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      let lastBar = "";
      try {
        const raw = JSON.parse(await readFile(`${KLINE}/${id}.json`, "utf8"));
        if (Array.isArray(raw) && raw.length > 0) lastBar = raw[raw.length - 1]?.date ?? "";
      } catch {
        lastBar = "";
      }
      if (lastBar >= anchor) {
        upToDate += 1;
        continue;
      }
      let fresh: Row[] | null = null;
      for (let attempt = 0; attempt < 3 && !fresh; attempt += 1) {
        try {
          const got = await fetchKline(id);
          if (got.length > 0) fresh = got;
        } catch {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (fresh) {
        await writeFile(`${KLINE}/${id}.json`, JSON.stringify(fresh));
        refreshed += 1;
      } else {
        failed += 1;
      }
      if ((refreshed + failed) % 100 === 0) {
        process.stderr.write(`  已处理 ${refreshed + failed + upToDate}/${ids.length} 只（重抓 ${refreshed} / 失败 ${failed}）\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  console.log(`\n刷新完成：重抓 ${refreshed} 只，已最新 ${upToDate} 只，失败 ${failed} 只`);
  if (failed > 0) console.log(`⚠️ ${failed} 只刷新失败，保留旧缓存（generate-signals 会跳过没有最新数据的票）`);
}

main().catch((e) => {
  console.error("K 线刷新失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
