/**
 * 这个文件是干什么的：
 * 拉行业板块的**日线 + 日级资金流**，聚合成月度写进 data/backtest/industry-monthly.json。
 * 这就是产业链 SOP 的「产业温度计」原料（D5）。
 *
 * 为什么是这些数字而不是价格/库存/capex：免费源里拿不到（国家统计局被 WAF 403 挡，
 * 行业协会数据要付费或得爬）。能稳定拿到的是东财板块日线（实测 4071 天）和日级
 * 资金流。**这是量价与资金维度的温度计，不是供需维度的**——读的时候别把它说成
 * 「行业景气度」，它只能说明价格和资金在往哪走。
 *
 * 已知的硬约束（别当 bug 修）：
 * 1. **东财有风控**：串行 + 每次间隔 ≥1.2s，别开并发。
 * 2. 日线拉最近 BARS 根（默认 400 ≈ 16 个月），够算 12 个月的月度序列。
 * 3. 增量：已有且不是 --force 的板块跳过；只补没拉过的。
 * 4. 解析与聚合全在 src/lib/market/industry-monthly.ts（有单测），脚本只拉和存。
 *
 * 跑法：
 *   node scripts/fetch-industry-monthly.mjs --limit 10   # 先验证
 *   node scripts/fetch-industry-monthly.mjs              # 全量（约 20 分钟）
 *   node scripts/fetch-industry-monthly.mjs --force      # 全部重算
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monthlyFromBars, parseBoardDaily, parseBoardFlow } from "../src/lib/market/industry-monthly.ts";

const here = new URL("..", import.meta.url).pathname;
const OUT = join(here, "data", "backtest", "industry-monthly.json");
const INDEX = join(here, "data", "backtest", "industry.json");
const UA = "Mozilla/5.0";
const GAP_MS = 1300;
const BARS = Number(process.env.BM_BARS ?? 400);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const LIMIT = Number(arg("--limit") ?? 0);
const ONLY = arg("--board");
const FORCE = process.argv.includes("--force");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const dailyUrl = (code) =>
  "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
  `?secid=90.${code}&ut=fa5fd1943c7b386f172d6893dbfba10b` +
  `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${BARS}`;

const flowUrl = (code) =>
  "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get" +
  `?secid=90.${code}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57&lmt=${BARS}`;

async function main() {
  let indexText;
  try {
    indexText = await readFile(INDEX, "utf-8");
  } catch {
    console.error(`读不到 ${INDEX}，先跑 node scripts/fetch-industry.mjs`);
    process.exit(1);
  }
  const index = JSON.parse(indexText);
  let boards = index.boards ?? [];
  if (ONLY) boards = boards.filter((b) => b.code === ONLY);
  if (LIMIT > 0) boards = boards.slice(0, LIMIT);
  if (boards.length === 0) {
    console.error("没有可拉的板块");
    process.exit(1);
  }

  let saved = {};
  if (!FORCE) {
    try {
      saved = JSON.parse(await readFile(OUT, "utf-8"));
    } catch {
      saved = {};
    }
  }
  const known = saved.boards ?? {};

  const out = { ...known };
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const board of boards) {
    if (!FORCE && known[board.code]?.months?.length) {
      skipped += 1;
      continue;
    }
    const dailyBody = await get(dailyUrl(board.code));
    const bars = parseBoardDaily(dailyBody);
    await sleep(GAP_MS);
    const flowBody = await get(flowUrl(board.code));
    const flow = parseBoardFlow(flowBody);
    await sleep(GAP_MS);
    if (bars.length === 0) {
      failed += 1;
      continue;
    }
    const { months } = monthlyFromBars(bars, flow, TODAY);
    out[board.code] = { code: board.code, name: board.name, months };
    done += 1;
    if ((done + skipped) % 25 === 0) console.log(`  已处理 ${done + skipped}/${boards.length}（新拉 ${done}）`);
  }

  const payload = { updatedAt: TODAY, boards: out };
  await mkdir(join(here, "data", "backtest"), { recursive: true });
  const tmp = `${OUT}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), "utf-8");
  await rename(tmp, OUT);

  console.log(`\n写好了 ${OUT}`);
  console.log(`  新拉 ${done}，跳过 ${skipped}（已有），失败 ${failed}，共 ${Object.keys(out).length} 个板块`);
  const sample = Object.values(out).find((b) => (b.months?.length ?? 0) > 0);
  if (sample) {
    const last = sample.months[sample.months.length - 1];
    console.log(`  例：${sample.name} 最新月 ${last.month} 收 ${last.close}，成交 ${last.sessions} 天，partial=${last.partial}`);
  }
}

main().catch((error) => {
  console.error("抓板块月度失败：", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
