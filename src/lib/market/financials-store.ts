/**
 * 这个文件是干什么的：
 * 读一只票的 baostock 三表序列（`data/backtest/financials.json`）。
 *
 * 你需要知道的：
 * - 这是 D2 的产物（scripts/fetch-three-sheets.py 抓的），**和东财业绩报表是两本账**：
 *   东财 fundamentals.json 只有比率（roe/dtYoy/gm，全市场 11636 只）；
 *   baostock financials.json 有绝对值（净利润/营收/EPS/杜邦/现金流），但**只抓了
 *   单只验证**（sh600519），全市场还没批量。
 * - data/ 不在 git 里，读不到就是没有，返回 null 让调用方写缺口。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FinancialRow } from "./financials.ts";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 读一只票的三表。找不到返回 null（没抓 / 换了机器 / data 不在 git）。 */
export async function loadFinancials(code: string, root = process.cwd()): Promise<FinancialRow[] | null> {
  try {
    const raw = await readFile(join(root, "data", "backtest", "financials.json"), "utf-8");
    const book = JSON.parse(raw) as { byCode?: Record<string, unknown[]> };
    const rows = book.byCode?.[code];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const out: FinancialRow[] = rows
      .filter((r): r is Record<string, unknown> => {
        const rec = r as Record<string, unknown> | null;
        return typeof rec === "object" && rec != null && typeof rec.pubDate === "string" && typeof rec.statDate === "string";
      })
      .map((r) => ({
        pubDate: r.pubDate as string,
        statDate: r.statDate as string,
        netProfit: num(r.netProfit),
        revenue: num(r.revenue),
        roe: num(r.roe),
        gpMargin: num(r.gpMargin),
        npMargin: num(r.npMargin),
        epsTTM: num(r.epsTTM),
        debt: num(r.debt),
        cfoToNp: num(r.cfoToNp),
        dupontROE: num(r.dupontROE),
        assetTurn: num(r.assetTurn),
        assetToEquity: num(r.assetToEquity),
        nitogr: num(r.nitogr),
      }));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
