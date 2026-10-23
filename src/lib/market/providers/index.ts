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

/**
 * 错误 → 日志字符串。fetch failed 这类消息不带原因，把 cause 挖出来——
 * 不然「腾讯源失败（fetch failed）」看不出是 WAF 掐断（ECONNRESET）、
 * 超时（ETIMEDOUT）还是 DNS，下次排障还得现抓。
 */
/**
 * ⚠️ **不要 top-level import node 内置模块**（2026-10-23 实测）：vite 会把它转成
 * 顶层解构，浏览器里一加载模块就抛「Module externalized for browser
 * compatibility」——整站 hydration 崩，页面能看不能点。改成函数内动态 import。
 */
const fsApi = () => import("node:fs/promises");

/** 拼路径（不用 node:path，理由同上）。 */
const dataPath = (...parts: string[]): string => [process.cwd(), ...parts].join("/");

export function messageOf(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause == null) return base;
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  const causeCode = typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : "";
  return `${base}（${[causeCode, causeMsg].filter(Boolean).join(": ")}）`;
}

/**
 * 北交所不在选股范围里，两个源都要挡掉，不能只挡一个。
 *
 * 原因有两条，都是实测出来的：一是腾讯的榜单接口根本没有北交所（bjs 返回 0 条），
 * 只有新浪那份名单里有 348 只；只在新浪那边放行的话，换源当天名单会凭空多出
 * 三百多只，选股结果跟着变，看不出是行情变了还是源变了。二是北交所的票在腾讯源
 * 里拿不到量比和近 5/20/60 日涨幅，突破和低估值这两套硬性要这些字段，等于一只
 * 都进不来；补涨走的是板块接口、不看这些字段，一旦选中北交所，第二天结算时
 * quotes.find 找不到它，这笔就永远挂在账上卖不掉。
 *
 * 涨跌停 30%、流动性也偏薄，短线这几套本来就不适合它。回测的样本池同样排除了
 * 北交所，两边口径一致。以后要放开，得先补一个能给齐字段的源。
 */
function withoutBj(quotes: Universe["quotes"]): Universe["quotes"] {
  return quotes.filter((quote) => !quote.id.startsWith("bj"));
}

function universeOf(quotes: Universe["quotes"], source: Universe["source"]): Universe {
  const rows = withoutBj(quotes);
  return { quotes: rows, asOf: Date.now(), total: rows.length, partial: false, stale: false, source };
}

/**
 * 换源之后哪些策略要停摆，说清楚，别让它静悄悄地整天不出票。
 *
 * 新浪那份名单里没有近 5/10/20/60 日涨幅，量比也是 0。所以一旦切到新浪：
 *   放量突破 要 d5、d20、量比 —— 一只都进不来
 *   中期反转 要 d60        —— 一只都进不来
 *   低估值   只要市盈率和市净率，新浪有  —— 照常
 *   次日补涨 走板块接口，不看这些字段   —— 照常
 * 页面上看不出来是「今天没有符合条件的票」还是「源换了没数据」，所以打一条日志。
 */
const DEGRADED_IMPACT = "缺近5/20/60日涨幅和量比：放量突破、中期反转两套停摆";

/** 降级状态落盘路径（data/market-degraded.json）。 */
const degradedPath = () =>
  [process.env.CHIHENG_DATA_DIR ?? dataPath("data"), "market-degraded.json"].join("/");

/** 降级状态 24 小时内视为「当前正处于降级」。 */
const DEGRADED_TTL_MS = 24 * 60 * 60 * 1000;

export type MarketDegraded = { at: string; source: string; impact: string };

async function writeDegraded(source: string): Promise<void> {
  try {
    const { mkdir, writeFile } = await fsApi();
    await mkdir(degradedPath() + "/..", { recursive: true });
    await writeFile(degradedPath(), JSON.stringify({ at: new Date().toISOString(), source, impact: DEGRADED_IMPACT }));
  } catch {
    // 状态文件是增强项，写失败不影响拉取本身。
  }
}

async function clearDegraded(): Promise<void> {
  try {
    const { unlink } = await fsApi();
    await unlink(degradedPath());
  } catch {
    // 没有文件可删，正常。
  }
}

/**
 * 当前是否处于行情降级（供策略层 AI 空返回归因：降级导致名单为空 ≠ AI 失职）。
 * 读不到/坏了/超过 24h 都返回 null——宁可不归因，不拿陈旧状态冤枉一轮。
 */
export async function readMarketDegraded(): Promise<MarketDegraded | null> {
  try {
    const { readFile } = await fsApi();
  const parsed = JSON.parse(await readFile(degradedPath(), "utf8")) as MarketDegraded;
    if (typeof parsed.at !== "string" || typeof parsed.source !== "string") return null;
    if (Date.now() - Date.parse(parsed.at) > DEGRADED_TTL_MS) return null;
    return { at: parsed.at, source: parsed.source, impact: typeof parsed.impact === "string" ? parsed.impact : DEGRADED_IMPACT };
  } catch {
    return null;
  }
}

function warnIfDegraded(source: Universe["source"]): void {
  if (source !== "sina") return;
  console.warn(`[行情] ${DEGRADED_IMPACT}，不是选不出票。`);
}

/** 拉全市场 A 股报价。先腾讯，失败后新浪，两个都失败才报错。 */
export async function fetchUniverse(): Promise<Universe> {
  try {
    const t = await fetchTencentUniverse();
    if (t.quotes.length < MIN_UNIVERSE) throw new Error(`名单不全：只有 ${t.quotes.length} 只`);
    await clearDegraded();
    return { ...universeOf(t.quotes, "tencent"), partial: t.partial };
  } catch (error) {
    console.warn(`[行情] 腾讯源失败（${messageOf(error)}），改用新浪财经`);
  }
  const s = await fetchSinaUniverse();
  if (s.quotes.length < MIN_UNIVERSE) throw new Error(`新浪名单不全：只有 ${s.quotes.length} 只`);
  console.warn(`[行情] 已切换到新浪财经源，共 ${s.quotes.length} 只`);
  warnIfDegraded("sina");
  await writeDegraded("sina");
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
