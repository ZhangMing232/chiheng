/**
 * 这个文件是干什么的：
 * 两个数据源（腾讯、东方财富）共用的工具：数字解析、板块判断、并发拉取。
 *
 * 你需要知道的：
 * 改这里会同时影响两路行情。数字解析会挡掉接口偶尔返回的离谱值。
 */

import type { Board } from "@/lib/market/types";

/** 把接口返回的值解析成数字。"-"、空串、解析不了都返回 null。pct 和 ratio 顺便挡掉离谱的数。 */
export function num(value: unknown, kind: "any" | "pct" | "ratio"): number | null {
  if (value == null || value === "" || value === "-") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (kind === "pct" && Math.abs(n) >= 400) return null;
  if (kind === "ratio" && Math.abs(n) >= 5000) return null;
  return n;
}

/** 判断股票在哪个市场。涨跌停幅度跟这个有关：主板 10%，创业板和科创板 20%，北证 30%。 */
export function boardOf(id: string, stockType: string): Board {
  const kind = stockType.toUpperCase();
  if (kind.includes("KCB") || id.startsWith("sh688") || id.startsWith("sh689")) return "kcb";
  if (kind.includes("CYB") || id.startsWith("sz300") || id.startsWith("sz301")) return "cyb";
  if (id.startsWith("bj") || kind.includes("BJ")) return "bj";
  if (id.startsWith("sh")) return "sh";
  return "sz";
}

/** 是不是 ST 或名字里带退市风险。这类票不进选股。 */
export function isSt(name: string): boolean {
  return name.toUpperCase().includes("ST") || name.includes("退");
}

/** 控制并发地跑一批异步任务，最多同时 limit 个。 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
