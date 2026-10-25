/**
 * 这个文件是干什么的：
 * 读 D6 的行业分类索引（`data/backtest/industry.json`）。
 *
 * 你需要知道的：
 * - 产物来自 scripts/fetch-industry.mjs（东财三级行业，496 个板块反查成分股）
 * - data/ 不在 git 里，换机器/没抓过就是没有。**读不到返回 null，让调用方写缺口**，
 *   不要返回一份空索引——空索引会让「这票没行业」和「没抓过」看起来一样
 * - 索引有 496 个板块 / 5589 只票，每次研判都读一遍太重，加 5 分钟内存缓存。
 *   抓数脚本一天跑一次，5 分钟足够新；真要立刻生效就重启服务
 *
 * ⚠️ **不要顶层 import node 内置模块**（2026-10-25 实测，第三次踩）：
 * 本文件被 research / strategies 路由**静态引用**，会进客户端 bundle。
 * vite 把 `import { readFile } from "node:fs/promises"` 转成**顶层解构**
 * 浏览器空壳桩，模块一求值就抛「Module externalized for browser
 * compatibility」——**整站 hydration 崩，页面能看、所有按钮按不动**
 * （SSR 正常、测试全绿，肉眼极难发现；dev 模式下 routeTree 静态引全部
 * 路由，任何一个路由链上的雷都会炸全站，不只炸那个页面）。
 * 规矩同 quotes.functions.ts：node 内置一律函数内动态 import；
 * 拼路径用 POSIX join（本机和部署目标都是 macOS/Linux，够用）。
 */

import { checkIndustryIndex, type IndustryIndex } from "./industry.ts";
import type { BoardMonthly } from "./industry-chain.ts";
import type { IndustryMonth } from "./industry-monthly.ts";
import { ttlOf } from "./fetch-policy.ts";

const fsApi = () => import("node:fs/promises");

/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

export const INDUSTRY_PATH = () => posixJoin("data", "backtest", "industry.json");
export const MONTHLY_PATH = () => posixJoin("data", "backtest", "industry-monthly.json");

const CACHE_MS = ttlOf("industry");

let cache: { at: number; index: IndustryIndex } | null = null;

/** 读行业分类索引。没抓过 / 结构非法 → null（结构问题打日志，别静默）。 */
export async function loadIndustry(root = process.cwd()): Promise<IndustryIndex | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.index;
  let raw: string;
  try {
    const { readFile } = await fsApi();
    raw = await readFile(posixJoin(root, INDUSTRY_PATH()), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[industry] ${INDUSTRY_PATH()} 不是合法 JSON，按「没抓过」处理`);
    return null;
  }
  const checked = checkIndustryIndex(parsed);
  if (!checked.ok) {
    console.error(`[industry] ${INDUSTRY_PATH()} 结构不对：${checked.reason}`);
    return null;
  }
  cache = { at: Date.now(), index: checked.index };
  return checked.index;
}

/** 读某个板块的月度序列（D5 温度计）。没抓过或没有这个板块 → null。 */
export async function loadBoardMonthly(code: string | null, root = process.cwd()): Promise<BoardMonthly | null> {
  if (!code) return null;
  let raw: string;
  try {
    const { readFile } = await fsApi();
    raw = await readFile(posixJoin(root, MONTHLY_PATH()), "utf-8");
  } catch {
    return null;
  }
  try {
    const book = JSON.parse(raw) as { boards?: Record<string, { name?: string; months?: IndustryMonth[] }> };
    const hit = book.boards?.[code];
    if (!hit || !Array.isArray(hit.months)) return null;
    return { code, name: hit.name ?? code, months: hit.months };
  } catch {
    console.error(`[industry] ${MONTHLY_PATH()} 不是合法 JSON，按「没抓过」处理`);
    return null;
  }
}
