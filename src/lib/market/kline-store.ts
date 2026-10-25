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

import type { KlineRow } from "./indicators.ts";

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 research.tsx 路由文件静态引用（routeTree 静态引全部路由——
 * 现在 loadKlines 只被 serverFn handler 用所以没进 bundle，但这是休眠雷：
 * 谁在组件/loader 里用它，模块立刻进 bundle 炸站）。node API 必须
 * 函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 */
const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

/** 读一只票的 K 线（按日期升序）。找不到返回 null。 */
export async function loadKlines(code: string, root = process.cwd()): Promise<KlineRow[] | null> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(posixJoin(root, "data", "backtest", "klines", `${code}.json`), "utf-8");
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
