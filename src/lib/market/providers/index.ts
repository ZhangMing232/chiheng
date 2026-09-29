/**
 * 这个文件是干什么的：
 * 行情数据源的统一入口。全市场快照和指数都先走腾讯，腾讯不行自动换东方财富。
 *
 * 你需要知道的：
 * 切换发生在每一次拉取，哪个源成功了就标在结果的 source 上，并写一条日志
 * （npm run mac:log 能看到）。全市场名单不到 4000 只就当这次拉取失败——
 * 残缺的名单比报错更危险，会把账本记错。以后接正规付费源，在这里加一路就行，
 * 页面和记账代码不用动。
 */

import type { IndexQuote, Universe } from "@/lib/market/types";
import { fetchTencentIndices, fetchTencentUniverse } from "@/lib/market/providers/tencent";
import { fetchEastmoneyIndices, fetchEastmoneyUniverse } from "@/lib/market/providers/eastmoney";

/** 全市场名单的最低只数。现在沪深京一共五千多只，低于这个数说明源返回得不完整。 */
const MIN_UNIVERSE = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 拉全市场 A 股报价。先腾讯，失败后换东方财富；两个都失败才报错。 */
export async function fetchUniverse(): Promise<Universe> {
  try {
    const t = await fetchTencentUniverse();
    if (t.quotes.length < MIN_UNIVERSE) throw new Error(`名单不全：只有 ${t.quotes.length} 只`);
    return { quotes: t.quotes, asOf: Date.now(), total: t.quotes.length, partial: t.partial, stale: false, source: "tencent" };
  } catch (error) {
    console.warn(`[行情] 腾讯源失败（${messageOf(error)}），改用东方财富`);
  }
  const e = await fetchEastmoneyUniverse();
  if (e.quotes.length < MIN_UNIVERSE) throw new Error(`东财名单不全：只有 ${e.quotes.length} 只`);
  console.warn(`[行情] 已切换到东方财富源，共 ${e.quotes.length} 只`);
  return { quotes: e.quotes, asOf: Date.now(), total: e.quotes.length, partial: e.partial, stale: false, source: "eastmoney" };
}

/** 拉常用指数现价。先腾讯，失败后换东方财富；两个都失败才报错。 */
export async function fetchIndices(ids: readonly string[]): Promise<IndexQuote[]> {
  try {
    return await fetchTencentIndices(ids);
  } catch (error) {
    console.warn(`[行情] 腾讯指数失败（${messageOf(error)}），改用东方财富`);
  }
  return fetchEastmoneyIndices(ids);
}
