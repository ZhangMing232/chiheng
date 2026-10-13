/**
 * 这个文件是干什么的：
 * 读一只票的日线 K 线（`data/backtest/klines/<code>.json`，fetch-kline.py 抓的）。
 *
 * 你需要知道的：
 * - **前复权**（adjust: qfq）。技术指标要的是价格序列连续，除权跳空会把
 *   MACD/KDJ/BOLL 全扭曲。注意这跟「结算用不复权、回测用 qfq」不是一回事——
 *   这里是技术指标专用口径，见 scripts/fetch-kline.py 头注释。
 * - data/ 不在 git，读不到就是没有，返回 null 让调用方写缺口。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KlineRow } from "./indicators.ts";

/** 读一只票的 K 线（按日期升序）。找不到返回 null。 */
export async function loadKlines(code: string, root = process.cwd()): Promise<KlineRow[] | null> {
  try {
    const raw = await readFile(join(root, "data", "backtest", "klines", `${code}.json`), "utf-8");
    const book = JSON.parse(raw) as { rows?: unknown[] };
    if (!Array.isArray(book.rows) || book.rows.length === 0) return null;
    const rows: KlineRow[] = [];
    for (const item of book.rows) {
      const r = item as Record<string, unknown>;
      const date = typeof r?.date === "string" ? r.date : null;
      const close = typeof r?.close === "number" ? r.close : null;
      if (!date || close == null) continue;
      rows.push({
        date,
        open: typeof r.open === "number" ? r.open : close,
        high: typeof r.high === "number" ? r.high : close,
        low: typeof r.low === "number" ? r.low : close,
        close,
      });
    }
    return rows.length > 0 ? rows.sort((a, b) => a.date.localeCompare(b.date)) : null;
  } catch {
    return null;
  }
}
