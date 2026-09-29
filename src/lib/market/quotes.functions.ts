/**
 * 这个文件是干什么的：
 * 行情总入口。拉全市场报价、指数和 K 线，并把资金、游资、期指、消息、选股、偏好和规则包成给页面调用的服务。
 *
 * 你需要知道的：
 * 涨跌幅是百分数，正涨负跌。全市场报价大约一分钟缓存，指数大约二十秒。拉失败时能用旧数据就标成过期。
 * 全市场快照和指数走 providers 适配层：腾讯是主源，东方财富是备份，换源会在日志里留一条记录。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { readRules, writeRules } from "@/lib/market/rules-file";
import { parseRules } from "@/lib/market/rules";
import { readPrefs, writePrefs } from "@/lib/market/prefs-file";
import { parsePrefs } from "@/lib/market/prefs";
import type { PaperDay } from "@/lib/paper";
import { loadRelay } from "@/lib/market/sectors";
import { loadNews, loadStockArticles, searchStocks, stockChg, type StockArticle, type StockHit } from "@/lib/market/news";
import { loadFlow } from "@/lib/market/flow";
import { loadHotMoney } from "@/lib/market/hotmoney";
import { loadIndexFutures } from "@/lib/market/index-futures";
import { ensureUserBook, readUserBook } from "@/lib/market/book-file";
import { sessionPhase } from "@/lib/market/session";
import type { Bar, IndexQuote, Universe } from "@/lib/market/types";
import { fetchIndices, fetchUniverse } from "@/lib/market/providers/index";

const TTL_MS = 60_000;
const INDEX_TTL_MS = 20_000;
/** K 线接口的请求头。全市场快照和指数已走 providers 适配层（腾讯主、东财备）。 */
const KLINE_HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://gu.qq.com/",
  accept: "application/json,text/plain,*/*",
};

const INDEX_IDS = ["sh510300", "sh000300", "sh000001", "sz399001", "sz399006", "sh000688"] as const;

let universeCache: { at: number; payload: Universe } | null = null;
let universeInflight: Promise<Universe> | null = null;
let indexCache: { at: number; rows: IndexQuote[] } | null = null;
const klineCache = new Map<string, { at: number; bars: Bar[] }>();

/** 拉全市场 A 股报价。refresh 为 true 时忽略缓存重拉。返回股票列表和时间；只拉到一部分或用了旧数据会标出来。 */
export async function loadUniverse(refresh: boolean): Promise<Universe> {
  if (!refresh && universeCache && Date.now() - universeCache.at < TTL_MS) {
    return universeCache.payload;
  }
  if (!refresh && universeInflight) return universeInflight;
  const run = (async () => {
    try {
      const payload = await fetchUniverse();
      universeCache = { at: payload.asOf, payload };
      return payload;
    } catch {
      if (universeCache) return { ...universeCache.payload, stale: true };
      throw new Error("行情暂时拉不下来，请稍后再刷新");
    }
  })();
  universeInflight = run;
  try {
    return await run;
  } finally {
    universeInflight = null;
  }
}

/** 拉几只常用指数和沪深300ETF 的现价。返回名称、价格、涨跌额和涨跌幅（百分数）。主源腾讯，挂了自动换东方财富；都失败时尽量用上次结果。 */
export async function loadIndices(): Promise<IndexQuote[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.rows;
  try {
    const rows = await fetchIndices(INDEX_IDS);
    indexCache = { at: Date.now(), rows };
    return rows;
  } catch {
    if (indexCache) return indexCache.rows;
    return [];
  }
}

/** 拉一只股票最近约 120 根前复权日 K。id 是 sh、sz 或 bj 加六位代码。返回日期、开高低收和成交量。 */
export async function loadKline(id: string): Promise<{ id: string; bars: Bar[] }> {
  const hit = klineCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return { id, bars: hit.bars };
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,120,qfq`;
  const res = await fetch(url, {
    headers: KLINE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("K 线暂时拉不下来");
  const body = (await res.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  const node = body.data?.[id];
  const rows = node?.qfqday ?? node?.day ?? [];
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const o = Number(row[1]);
    const c = Number(row[2]);
    const h = Number(row[3]);
    const l = Number(row[4]);
    const v = Number(row[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    bars.push({ date: row[0] ?? "", o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  klineCache.set(id, { at: Date.now(), bars });
  if (klineCache.size > 40) {
    const oldest = klineCache.keys().next().value;
    if (oldest) klineCache.delete(oldest);
  }
  return { id, bars };
}

function readRefresh(data: unknown): { refresh: boolean } {
  if (
    typeof data === "object" &&
    data !== null &&
    "refresh" in data &&
    (data as { refresh?: unknown }).refresh === true
  ) {
    return { refresh: true };
  }
  return { refresh: false };
}

/** 给页面用的全市场报价。可传 refresh: true 强制刷新。 */
export const getUniverse = createServerFn({ method: "GET" })
  .validator(readRefresh)
  .handler(async ({ data }) => loadUniverse(data.refresh));

/** 给页面用的指数行情。没有参数。 */
export const getIndices = createServerFn({ method: "GET" }).handler(async () => loadIndices());

/** 给页面用的接力选股。按现在是不是尾盘、以及今天的日期去取名单。 */
export const getRelay = createServerFn({ method: "GET" }).handler(async () => {
  const phase = sessionPhase();
  return loadRelay(phase.tailHalf, phase.date);
});

/** 给页面用的 7x24 快讯。没有参数。 */
export const getNews = createServerFn({ method: "GET" }).handler(async () => loadNews());

function countTone(articles: StockArticle[], tone: StockArticle["tone"]): number {
  return articles.filter((item) => item.tone === tone).length;
}

/** 给页面用的个股消息。q 是代码或名称时搜一只并带上资讯；不传 q 时看账上还没卖的持仓，最多 8 只。 */
export const getSymbolNews = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const q =
      typeof data === "object" && data !== null && "q" in data && typeof (data as { q?: unknown }).q === "string"
        ? (data as { q: string }).q.trim().slice(0, 20)
        : "";
    return { q };
  })
  .handler(async ({ data }) => {
    if (data.q) {
      const matches = await searchStocks(data.q).catch(() => [] as StockHit[]);
      const picked = matches[0] ?? null;
      const articles = picked ? await loadStockArticles(picked.id).catch(() => [] as StockArticle[]) : [];
      const chg = picked ? ((await stockChg([picked.id])).get(picked.id) ?? null) : null;
      return {
        q: data.q,
        matches,
        picked: picked ? { ...picked, chg } : null,
        articles,
        groups: [] as { id: string; name: string; code: string; chg: number | null; articles: StockArticle[] }[],
      };
    }
    let days: { trades?: { id?: string; code?: string; name?: string; exit?: number | null }[] }[] = [];
    try {
      const { requireUserId } = await import("@/lib/auth/verify.server");
      const userId = await requireUserId();
      await ensureUserBook(userId);
      const book = await readUserBook<{ trades?: { id?: string; code?: string; name?: string; exit?: number | null }[] }>(userId);
      days = book.days;
    } catch {
      days = [];
    }
    const held: { id: string; name: string; code: string }[] = [];
    const seen = new Set<string>();
    for (const day of days) {
      for (const trade of day.trades ?? []) {
        if (trade.exit != null || !trade.id || seen.has(trade.id)) continue;
        seen.add(trade.id);
        held.push({ id: trade.id, name: trade.name || trade.id, code: trade.code || trade.id.slice(2) });
        if (held.length >= 8) break;
      }
      if (held.length >= 8) break;
    }
    const groups = await Promise.all(
      held.map(async (trade) => ({
        ...trade,
        articles: (await loadStockArticles(trade.id).catch(() => [] as StockArticle[])).slice(0, 8),
      })),
    );
    const moves = await stockChg(groups.map((group) => group.id));
    const withChg = groups
      .map((group) => ({ ...group, chg: moves.get(group.id) ?? null }))
      .sort((a, b) => countTone(b.articles, "bad") - countTone(a.articles, "bad"));
    return { q: "", matches: [] as StockHit[], picked: null, articles: [] as StockArticle[], groups: withChg };
  });

/** 给页面用的资金账。没有参数。金额在账里是万元。 */
export const getFlow = createServerFn({ method: "GET" }).handler(async () => loadFlow());

/** 给页面用的龙虎榜席位。没有参数。净额是万元。 */
export const getHotMoney = createServerFn({ method: "GET" }).handler(async () => loadHotMoney());

/** 给页面用的股指期货持仓。没有参数。单位是手。 */
export const getIndexFutures = createServerFn({ method: "GET" }).handler(async () => loadIndexFutures());

/** 给页面用的日 K。传入 { id }，id 必须是 sh、sz 或 bj 加六位代码。 */
export const getKline = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof (data as { id?: unknown }).id !== "string"
    ) {
      throw new Error("无效的股票代码");
    }
    const id = (data as { id: string }).id;
    if (!/^(sh|sz|bj)\d{6}$/.test(id)) throw new Error("无效的股票代码");
    return { id };
  })
  .handler(async ({ data }) => loadKline(data.id));

/** 读本机记录器状态。返回上次记录时间 at（毫秒，没有是 null）和是否正常 ok。 */
export const getRecorder = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const text = await readFile(join(process.cwd(), "data", "recorder.json"), "utf8");
    const parsed = JSON.parse(text) as { at?: unknown; ok?: unknown };
    return {
      at: typeof parsed.at === "number" ? parsed.at : null,
      ok: parsed.ok !== false,
    };
  } catch {
    return { at: null as number | null, ok: true };
  }
});

/** 读当前登录用户的交易日记。没登录就返回空列表。personal 表示是不是本人账本。 */
export const getServerJournal = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const userId = await requireUserId();
    await ensureUserBook(userId);
    const book = await readUserBook<PaperDay>(userId);
    return { days: book.days, personal: true };
  } catch {
    return { days: [] as PaperDay[], personal: false };
  }
});

/** 读选股规则。读不到文件就用默认规则。 */
export const getRules = createServerFn({ method: "GET" }).handler(async () => readRules());

/** 保存选股规则。区间要左边小于右边，填不完整会报错。选股条件变了，版本号加一。 */
export const saveRules = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const parsed = parseRules(data);
    if (!parsed) throw new Error("规则填得不完整，区间要左边小于右边");
    return parsed;
  })
  .handler(async ({ data }) => writeRules(data));

/** 读页面偏好（策略、板块、价位、市值）。读不到就用默认。 */
export const getPrefs = createServerFn({ method: "GET" }).handler(async () => readPrefs());

/** 保存页面偏好。填不对会报错。 */
export const savePrefs = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const parsed = parsePrefs(data);
    if (!parsed) throw new Error("偏好没填对");
    return parsed;
  })
  .handler(async ({ data }) => writePrefs(data));
