/**
 * 这个文件是干什么的：
 * 行情数据源的统一入口。全市场快照和指数都先走腾讯；腾讯不行，全市场换新浪、
 * 指数换东方财富（东财的全市场名单接口在本机网络下不通，指数接口正常）。
 *
 * 你需要知道的：
 * 切换发生在每一次拉取，哪个源成功了就标在结果的 source 上，并写一条日志
 * （npm run mac:log 能看到）。全市场名单不到 4000 只就当这次拉取失败——
 * 残缺的名单比报错更危险，会把账本记错。以后接正规付费源，在这里加一路就行，
 * 页面和记账代码不用动。
 */

import type { IndexQuote, Universe } from "@/lib/market/types";
import { fetchTencentIndices, fetchTencentUniverse } from "@/lib/market/providers/tencent";
import { fetchSinaUniverse } from "@/lib/market/providers/sina";
import { fetchEastmoneyIndices } from "@/lib/market/providers/eastmoney";

/** 全市场名单的最低只数。现在沪深京一共五千多只，低于这个数说明源返回得不完整。 */
const MIN_UNIVERSE = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function universeOf(quotes: Universe["quotes"], source: Universe["source"]): Universe {
  return { quotes, asOf: Date.now(), total: quotes.length, partial: false, stale: false, source };
}

/** 拉全市场 A 股报价。先腾讯，失败后新浪，两个都失败才报错。 */
export async function fetchUniverse(): Promise<Universe> {
  try {
    const t = await fetchTencentUniverse();
    if (t.quotes.length < MIN_UNIVERSE) throw new Error(`名单不全：只有 ${t.quotes.length} 只`);
    return { ...universeOf(t.quotes, "tencent"), partial: t.partial };
  } catch (error) {
    console.warn(`[行情] 腾讯源失败（${messageOf(error)}），改用新浪财经`);
  }
  const s = await fetchSinaUniverse();
  if (s.quotes.length < MIN_UNIVERSE) throw new Error(`新浪名单不全：只有 ${s.quotes.length} 只`);
  console.warn(`[行情] 已切换到新浪财经源，共 ${s.quotes.length} 只`);
  return { ...universeOf(s.quotes, "sina"), partial: s.partial };
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
