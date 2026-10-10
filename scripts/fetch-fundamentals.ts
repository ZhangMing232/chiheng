/**
 * 这个文件是干什么的：
 * 从 tushare 抓基本面财报数据（fina_indicator），落 data/backtest/fundamentals.json，
 * 给回测里的三个基本面因子（ROE / 扣非同比 / 资产负债率）当原料。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-fundamentals.ts
 *
 * 抓法（按报告期全市场批量，不是一只只抓）：
 *   fina_indicator 支持 period=YYYYMMDD 一次返回全市场该季度的记录——
 *   8 个季度 ≈ 8 次 API 调用，不会被限频卡死。一只只抓 5000 只 = 5000 次，不行。
 *
 * PIT 命脉：只收 ann_date（披露日）非空的记录。没披露日 = 市面上还没这条
 * 财报，收了就是给回测埋前视（fundamentals.ts 的 pitValue 注释同一铁律）。
 *
 * 多久跑一次：财报季度发。每季度末后一个月跑一次（4/8/10 月底），或要跑
 * 基本面因子检验前手动跑一次。数据落 data/（git 外），回测读不到就跳过基本面因子。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callTushare } from "@/lib/market/tushare";
import { recentQuarters, type FundamentalFile, type FundamentalRecord } from "@/lib/market/fundamentals";

/** 回看多少个季度。8 个季度 ≈ 两年，覆盖回测窗口（250 个交易日）绰绰有余。 */
const QUARTERS = 8;

const FIELDS = "ts_code,ann_date,end_date,roe,dt_netprofit_yoy,debt_to_assets";

/** tushare 代码 '600519.SH' → 赤轨代码 'sh600519'（和 K 线缓存、账本同一格式）。 */
function toChiheng(tsCode: string): string {
  const [num, ex] = tsCode.split(".");
  return `${ex.toLowerCase()}${num}`;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === "" || Number.isNaN(n) ? null : n;
};

async function main() {
  const periods = recentQuarters();
  console.log(`抓取 ${periods.length} 个报告期的 fina_indicator：${periods.join("、")}`);
  const byCode: Record<string, FundamentalRecord[]> = {};
  let rows = 0;
  let skippedNoAnn = 0;
  for (const period of periods) {
    const batch = await callTushare("fina_indicator", { period }, FIELDS);
    for (const r of batch) {
      const ann = String(r.ann_date ?? "").trim();
      if (!ann) {
        skippedNoAnn += 1;
        continue; // 没披露日 = 市面上还没有，收了就是前视
      }
      const code = toChiheng(String(r.ts_code));
      (byCode[code] ??= []).push({
        ann,
        roe: numOrNull(r.roe),
        dtYoy: numOrNull(r.dt_netprofit_yoy),
        debt: numOrNull(r.debt_to_assets),
      });
    }
    rows += batch.length;
    console.log(`  ${period}：${batch.length} 行`);
  }
  // 每只票按披露日升序排——pitValue 的热路径契约（fundamentals.ts）。
  for (const list of Object.values(byCode)) list.sort((a, b) => a.ann.localeCompare(b.ann));
  const file: FundamentalFile = { fetchedAt: new Date().toISOString(), periods, byCode };
  const out = join(process.cwd(), "data", "backtest");
  await mkdir(out, { recursive: true });
  const path = join(out, "fundamentals.json");
  await writeFile(path, JSON.stringify(file));
  console.log(`完成：${Object.keys(byCode).length} 只票、${rows} 行（${skippedNoAnn} 行无披露日已跳过）→ ${path}`);
  console.log("下一步：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts（BT_FACTOR=1）");
}

await main();
