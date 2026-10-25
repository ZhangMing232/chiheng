/**
 * 这个文件是干什么的：
 * 读一只票的财报比率序列（`data/backtest/fundamentals.json`）。
 *
 * 你需要知道的：
 * - **产物里没有报告期字段**，只有公告日期 `ann`（2026-10-12 实测确认）。
 *   所以 `EarningsPoint.period` 用 ann 填——不是笔误，是源就没给。
 *   判断转向本来就看公告顺序，报告期只用于展示。
 * - `data/` 不在 git 里，读不到就是没有，返回 null，调用方写缺口。
 */

import type { EarningsPoint } from "./earnings-sop.ts";

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经路由文件静态引用（routeTree 静态引全部路由），node API 必须
 * 函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 */
const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

type RawRow = { ann?: unknown; roe?: unknown; dtYoy?: unknown; gm?: unknown; debt?: unknown };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 读一只票的财报序列。找不到返回 null（没跑脚本 / 这只票没数据 / 换了机器）。 */
export async function loadEarnings(code: string, root = process.cwd()): Promise<EarningsPoint[] | null> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(posixJoin(root, "data", "backtest", "fundamentals.json"), "utf-8");
    const book = JSON.parse(raw) as { byCode?: Record<string, RawRow[]> };
    const rows = book.byCode?.[code];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const points: EarningsPoint[] = rows
      .filter((row): row is RawRow => typeof row?.ann === "string")
      .map((row) => ({
        // 源不给报告期，用公告日期填（只影响展示，转向判断看的是公告顺序）
        ann: row.ann as string,
        period: row.ann as string,
        roe: num(row.roe),
        dtYoy: num(row.dtYoy),
        gm: num(row.gm),
        debt: num(row.debt),
      }));
    return points.length > 0 ? points : null;
  } catch {
    return null;
  }
}
