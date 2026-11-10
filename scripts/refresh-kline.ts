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
 * 2026-11-10 修「800 根冻结」：原来 rawLen >= 800 就跳过、抓到整文件覆盖——
 * 2504 只全史因此停在 11-06，真刷到又会被砍剩 800 根。现在按**日期**判新鲜，
 * 新抓的尾巴 mergeTail 合并进缓存（全史一根不动），接缝自动对齐复权基准/量单位。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/refresh-kline.ts
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;
const LOOKBACK = 250;
/** 抓取长度，默认 800（≈3.2 年）。BT_KLINE_DAYS 可调小做对照。 */
const KLINE_FETCH_DAYS = Number(process.env.BT_KLINE_DAYS ?? 800);
// 腾讯 K 线接口并发稍高就限流（实测 4 并发抽 200 只只有 39% 命中），预刷必须压并发 + 加间隔。
const WORKERS = Number(process.env.BT_WARM_WORKERS ?? 2);
const REQ_DELAY = Number(process.env.BT_WARM_DELAY ?? 250);
const RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

const KLINE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://gu.qq.com/",
};

/** 腾讯前复权日线（和 backtest.ts 的 fetchKline 同源同口径）。 */
async function fetchKline(id: string): Promise<Row[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,${KLINE_FETCH_DAYS},qfq`;
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

/** 用沪深 300 指数当「最新交易日」尺子，返回**已收完**的最后一天：
 *  15:05 前盘中跑，腾讯会给今天的半日 bar——不算数，退回上一根。
 *  指数走 qfq 接口会 501（指数无复权），失败返回空串＝不知道，worker 就全量核对日期。 */
async function latestTradingDay(): Promise<string> {
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const d = new Date();
  const sealed = d.getHours() > 15 || (d.getHours() === 15 && d.getMinutes() >= 5);
  try {
    const rows = await fetchKline("sh000300");
    const usable = sealed ? rows : rows.filter((r) => r.date < todayStr);
    return usable[usable.length - 1]?.date ?? "";
  } catch {
    return sealed ? todayStr : "";
  }
}

/** 把新抓的尾巴接进缓存，不整文件覆盖——全史（2500+ 根）是回测 2000 窗口的命根子，
 *  旧写法「rawLen >= 800 就跳过、抓到就整文件覆盖」造成两个洞：全史永不更新
 *  （2026-11-10 实测 2504 只停在 11-06），真刷到又会把全史砍剩 800 根。
 *
 *  接缝两道保险（同日对不齐就地修正，对不齐的幅度实测过才定的阈值）：
 *  - 复权基准：腾讯 qfq 遇分红整体换基准，拿同一天收盘比出比例把尾巴缩回旧基准，
 *    否则接缝处假跳空；基准没变（比例 ≈1）不动。
 *  - 量单位：腾讯科创板是「股」其余「手」，和 baostock 历史可能差 100 倍；
 *    同日量比只修 100/0.01 倍的单位差，正常波动不碰。 */
function mergeTail(existing: Row[], fresh: Row[]): { rows: Row[]; added: number; basis: number | null; vUnit: number | null } {
  if (existing.length === 0) return { rows: fresh, added: fresh.length, basis: null, vUnit: null };
  const lastDate = existing[existing.length - 1]!.date;
  const tail = fresh.filter((r) => r.date > lastDate);
  if (tail.length === 0) return { rows: existing, added: 0, basis: null, vUnit: null };
  const byDate = new Map(fresh.map((r) => [r.date, r]));
  let basis: number | null = null;
  let vUnit: number | null = null;
  for (let i = existing.length - 1; i >= 0 && i >= existing.length - 30; i--) {
    const same = byDate.get(existing[i]!.date);
    if (!same) continue;
    const e = existing[i]!;
    if (e.c > 0 && same.c > 0) {
      const ratio = e.c / same.c;
      if (Math.abs(ratio - 1) > 0.005) {
        basis = ratio;
        for (const r of tail) {
          r.o *= ratio;
          r.c *= ratio;
          r.h *= ratio;
          r.l *= ratio;
        }
      }
    }
    if (e.v > 0 && same.v > 0) {
      const vr = e.v / same.v;
      const snapped = vr >= 50 ? 100 : vr <= 0.02 ? 0.01 : 1;
      if (snapped !== 1 && Math.abs(vr - snapped) < snapped * 0.05) {
        vUnit = snapped;
        for (const r of tail) r.v *= snapped;
      }
    }
    break; // 只按最近一个同日判基准/单位
  }
  return { rows: [...existing, ...tail], added: tail.length, basis, vUnit };
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

  // 2. 最新交易日尺子（已收完的最后一天；盘中跑不含今天的半日 bar）
  const anchor = await latestTradingDay();
  console.log(`最新已收完交易日（沪深300 末根）：${anchor || "未知，按日期全量核对"}\n`);

  // 3. 并发刷新：最后 K 线早于 anchor 的（或缺失的）重抓，尾巴合并进缓存
  await mkdir(KLINE, { recursive: true });
  let refreshed = 0;
  let upToDate = 0;
  let noChange = 0;
  let failed = 0;
  let seamFixed = 0;
  const queue = [...ids];
  const todayStr = new Date().toLocaleDateString("sv-SE");
  const d2 = new Date();
  const sealed = d2.getHours() > 15 || (d2.getHours() === 15 && d2.getMinutes() >= 5);

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      let existing: Row[] = [];
      try {
        const raw = JSON.parse(await readFile(`${KLINE}/${id}.json`, "utf8"));
        if (Array.isArray(raw)) existing = raw;
      } catch {
        existing = [];
      }
      // 已经追到最新交易日就跳过。旧的「800 根就跳过」正是 2504 只全史冻结的病根
      const lastDate = existing.length > 0 ? existing[existing.length - 1]!.date : "";
      if (anchor !== "" && lastDate >= anchor) {
        upToDate += 1;
        continue;
      }
      let fresh: Row[] | null = null;
      for (let attempt = 0; attempt < RETRIES && !fresh; attempt += 1) {
        try {
          const got = await fetchKline(id);
          if (got.length > 0) fresh = got;
        } catch {
          await sleep(600 * (attempt + 1));
        }
        await sleep(REQ_DELAY); // 每轮请求之间留间隔，避免触发限流
      }
      if (!fresh) {
        failed += 1;
      } else {
        // 当日半日 bar 不接（15:05 前跑腾讯会给今天的进行时 bar）
        const rows = fresh.filter((r) => sealed || r.date < todayStr);
        const merged = mergeTail(existing, rows);
        if (merged.added > 0) {
          await writeFile(`${KLINE}/${id}.json`, JSON.stringify(merged.rows));
          refreshed += 1;
          if (merged.basis != null || merged.vUnit != null) {
            seamFixed += 1;
            process.stderr.write(`  ${id} 接缝修正：复权基准 ×${(merged.basis ?? 1).toFixed(4)}、量单位 ×${merged.vUnit ?? 1}（接上 ${merged.added} 根）\n`);
          }
        } else {
          noChange += 1;
        }
      }
      if ((refreshed + failed + noChange) % 100 === 0) {
        process.stderr.write(`  已处理 ${refreshed + failed + noChange + upToDate}/${ids.length} 只（追加 ${refreshed} / 失败 ${failed}）\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));

  console.log(`\n刷新完成：追加 ${refreshed} 只（其中 ${seamFixed} 只做了接缝修正），已最新 ${upToDate} 只，无可加 ${noChange} 只，失败 ${failed} 只`);
  if (failed > 0) console.log(`⚠️ ${failed} 只刷新失败，保留旧缓存（generate-signals 会跳过没有最新数据的票）`);
}

main().catch((e) => {
  console.error("K 线刷新失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
