/**
 * 这个文件是干什么的：
 * 行情总入口。拉全市场报价、指数和 K 线，并把资金、游资、期指、消息、选股、偏好和规则包成给页面调用的服务。
 *
 * 你需要知道的：
 * 涨跌幅是百分数，正涨负跌。全市场报价大约一分钟缓存，指数大约二十秒。拉失败时能用旧数据就标成过期。
 * 全市场快照和指数走 providers 适配层：腾讯是主源，东方财富是备份，换源会在日志里留一条记录。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { readRules, writeRules } from "@/lib/market/rules-file";
import { parseRules } from "@/lib/market/rules";
import { readPrefs, writePrefs } from "@/lib/market/prefs-file";
import { parsePrefs } from "@/lib/market/prefs";
import { readBaseline, readFactorDiag, readFactorRuns } from "@/lib/market/factor-runs-file";
import { systemRules } from "@/lib/market/system-rules";
import { sanitizeParams } from "@/lib/market/factor-test-runner";
import { aiStatus, readQueue, runFactorAILoop } from "@/lib/market/factor-queue";
import { loadBacktestRuns } from "@/lib/market/backtest-runs";
import { readAILog } from "@/lib/market/ai-log";
import { profileStatus, readProfiles } from "@/lib/market/ai-profiles";
import type { PaperDay } from "@/lib/paper";
import { loadRelay } from "@/lib/market/sectors";
import { loadNews, loadStockArticles, searchStocks, stockChg, type StockArticle, type StockHit } from "@/lib/market/news";
import { loadFlow } from "@/lib/market/flow";
import { loadHotMoney } from "@/lib/market/hotmoney";
import type { MarginRow } from "@/lib/market/margin";
import { fetchHolders, fetchLifts, upcomingLifts } from "@/lib/market/holder-lift";
import { loadIndexFutures } from "@/lib/market/index-futures";
import { ensureUserBook, readUserBook } from "@/lib/market/book-file";
import { sessionPhase } from "@/lib/market/session";
import type { Bar, IndexQuote, Trend, TrendPoint, Universe } from "@/lib/market/types";
import { fetchIndices, fetchUniverse } from "@/lib/market/providers/index";
import { fetchOverseasKline, fetchOverseasQuote, searchOverseas } from "@/lib/market/providers/overseas";
import { ID_PATTERN, marketOf } from "@/lib/market/markets";
import { ttlOf } from "@/lib/market/fetch-policy";

/**
 * 全市场快照的缓存时间。
 *
 * 原来是 60 秒，但记账脚本每分钟被拉起来一个新进程，进程内的缓存每次都是空的，
 * 于是等于每分钟全量拉一次 5200 多只股票——一个交易日 240 次、百来万条记录。
 * 腾讯的接口会被这种频率顶到 WAF（返回 501），K 线拉不到、结算就卡住。
 *
 * 三分钟足够：这些策略持股 10 个交易日，两次快照之间差三分钟不影响任何判断。
 * 真正需要最新的只有买卖窗口（9:25–9:30 和 14:40–15:00）和补涨冻结那半小时，
 * 那边由 record-journal 显式要求刷新。
 */
const TTL_MS = 3 * 60_000;
const INDEX_TTL_MS = 20_000;
/** 快照落盘的位置。进程内的缓存活不过一次记账，落盘才能跨进程复用。 */
const UNIVERSE_CACHE = () => join(process.cwd(), "data", "universe-cache.json");
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
const trendCache = new Map<string, { at: number; trend: Trend }>();

type Snapshot = { at: number; payload: Universe };

async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const text = await readFile(UNIVERSE_CACHE(), "utf8");
    const parsed = JSON.parse(text) as Partial<Snapshot>;
    if (typeof parsed?.at !== "number" || !parsed.payload || !Array.isArray(parsed.payload.quotes)) return null;
    return { at: parsed.at, payload: parsed.payload as Universe };
  } catch {
    return null;
  }
}

/** 落盘要先写临时文件再改名：两个进程同时写的话，直接覆盖会把文件写成半截。 */
async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  const target = UNIVERSE_CACHE();
  // 临时名带 pid **和随机数**：只带 pid 的话，同一个进程里两个并发协程
  // （比如两个请求同时触发拉快照）会算出同一个临时名，一个 rename 成功后
  // 另一个 ENOENT——写失败会被下面 catch 吞掉，表现为「这分钟没刷新」而不是报错。
  const staged = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(staged, JSON.stringify(snapshot));
    await rename(staged, target);
  } catch {
    // 缓存写不进去不算错，最多是下一分钟多拉一次
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

/**
 * 拉全市场 A 股报价。refresh 为 true 时忽略缓存重拉。
 *
 * 三层：进程内 → 落盘 → 真拉。落盘这层是为了跨进程复用：记账脚本每分钟起一个新进程，
 * 只靠进程内缓存的话等于没有缓存。返回的 Universe 带 asOf（快照时间）和 source，
 * 页面上要把「数据源 · 多久前」显示出来——主源降级时策略会静默不出票，
 * 那天就是靠翻日志才定位到的。
 */
export async function loadUniverse(refresh: boolean): Promise<Universe> {
  const now = Date.now();
  if (!refresh && universeCache && now - universeCache.at < TTL_MS) {
    return universeCache.payload;
  }
  if (!refresh && universeInflight) return universeInflight;
  const run = (async () => {
    // 落盘快照也够新就不去打扰腾讯了
    if (!refresh) {
      const disk = await readSnapshot();
      if (disk && now - disk.at < TTL_MS) {
        universeCache = disk;
        return disk.payload;
      }
    }
    try {
      const payload = await fetchUniverse();
      const snapshot: Snapshot = { at: payload.asOf, payload };
      universeCache = snapshot;
      void writeSnapshot(snapshot);
      return payload;
    } catch {
      // 拉不到就用旧的：进程内的优先，再退到落盘的，并标成过期让页面能提示
      if (universeCache) return { ...universeCache.payload, stale: true };
      const disk = await readSnapshot();
      if (disk) {
        universeCache = disk;
        return { ...disk.payload, stale: true };
      }
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

/**
 * 拉一只股票最近约 120 根**不复权**日 K。id 是 sh、sz 或 bj 加六位代码。返回日期、开高低收和成交量。
 *
 * 这里必须是原始价，不能要前复权。账上记的买入价、止损价、卖出价都是当时用
 * 真实报价算出来的（未复权口径），结算时拿的 K 线得和它们同口径。用前复权的话，
 * 持仓期间一旦除权除息或高送转，K 线整段被往下调，而买入价不动，于是「跌到止损」
 * 会被提前触发，一笔真实亏掉一半的仓位被记成只亏了几个点。实测 10 送 10 的情形：
 * 股价从 10 元腰斩到 5 元，前复权口径下被算成 -3.0%（按止损价 9.7 成交）。
 *
 * 不复权带来的另一个问题在 exitFill 里解决了：除权日那天相对昨收会突然腰斩，
 * 单看跌幅会被误判成跌停封死而跳过。跌停最多只能跌 limitPct，超出这个幅度
 * 就一定不是跌停，所以那边按跌幅先把这种情况挡掉。
 */
export async function loadKline(id: string): Promise<{ id: string; bars: Bar[] }> {
  // 港/美（M1/M2）走东财港美行情域，和 A 股腾讯域完全分开；缓存口径相同。
  if (marketOf(id) !== "a") {
    const bars = await fetchOverseasKline(id);
    return { id, bars };
  }
  const hit = klineCache.get(id);
  if (hit && Date.now() - hit.at < ttlOf("kline")) return { id, bars: hit.bars };
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,120`;
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

/**
 * 拉一只指数最近一个交易日的分钟走势（分时）。腾讯同一个行情域名的 day/query 接口，
 * 返回 "HHMM 价格 成交量 累计成交额" 的分钟行。取最后一天（今天；盘前则是上一交易日），
 * 昨收优先取当天的 prec，没有就用快照行情里的昨收。画大盘分时用，约 30 秒缓存。
 */
export async function loadTrend(id: string): Promise<Trend> {
  const hit = trendCache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.trend;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${id}`;
  const res = await fetch(url, {
    headers: KLINE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("分时暂时拉不下来");
  const body = (await res.json()) as {
    data?: Record<
      string,
      {
        data?: Array<{ date?: string; data?: string[]; prec?: string }>;
        qt?: Record<string, string[]>;
      }
    >;
  };
  const node = body.data?.[id];
  const days = node?.data ?? [];
  const last = days[days.length - 1];
  if (!last?.data || last.data.length < 2) throw new Error("分时暂时没有数据");
  const points: TrendPoint[] = [];
  for (const line of last.data) {
    const [time, price] = (line ?? "").split(" ");
    const value = Number(price);
    if (!/^\d{4}$/.test(time ?? "") || !Number.isFinite(value)) continue;
    points.push({ time, price: value });
  }
  if (points.length < 2) throw new Error("分时暂时没有数据");
  const qtRow = node?.qt?.[id];
  const prevClose = Number(last.prec ?? qtRow?.[4] ?? "");
  const trend: Trend = {
    id,
    date: last.date ?? "",
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
    points,
  };
  trendCache.set(id, { at: Date.now(), trend });
  if (trendCache.size > 8) {
    const oldest = trendCache.keys().next().value;
    if (oldest) trendCache.delete(oldest);
  }
  return trend;
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

/** 给页面用的回测运行记录。读本地 JSONL，只能在服务端跑（客户端导航时 loader 会在浏览器执行）。 */
export const getBacktestRuns = createServerFn({ method: "GET" }).handler(async () => loadBacktestRuns());

/** 给页面用的指数分时走势。id 限常用指数，例如 sh000001。 */
export const getTrend = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const id =
      typeof data === "object" && data !== null && "id" in data && typeof (data as { id?: unknown }).id === "string"
        ? (data as { id: string }).id
        : "";
    if (!(INDEX_IDS as readonly string[]).includes(id)) throw new Error("只支持常用指数的分时");
    return { id };
  })
  .handler(async ({ data }) => loadTrend(data.id));

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

/** 两融个股明细（D3）。读 data/risk/margin-latest.json 产物，读不到带 why 不编造。 */
export const getMargin = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const text = await readFile(join(process.cwd(), "data", "risk", "margin-latest.json"), "utf8");
    const parsed = JSON.parse(text) as { date: string; rows: MarginRow[]; missing: number; fetchedAt: string };
    return { ...parsed, why: null as string | null };
  } catch (error) {
    return {
      date: "",
      rows: [] as MarginRow[],
      missing: 0,
      fetchedAt: null,
      why: `两融快照读不到（${(error as Error).message}）。先跑 node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-margin.ts`,
    };
  }
});

/** 股东户数最近几期（D4）。id 带 sh/sz/bj 前缀，这里剥掉。拉不到抛错，页面降级。 */
export const getHolders = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof (data as { id?: unknown }).id !== "string" ||
      !/^(sh|sz|bj)\d{6}$/.test((data as { id: string }).id)
    ) {
      throw new Error("无效的股票代码");
    }
    return { id: (data as { id: string }).id };
  })
  .handler(async ({ data }) => fetchHolders(data.id.replace(/^(sh|sz|bj)/, "")));

/** 未来 90 天解禁（D4）。今天按服务器时钟算。 */
export const getLifts = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof (data as { id?: unknown }).id !== "string" ||
      !/^(sh|sz|bj)\d{6}$/.test((data as { id: string }).id)
    ) {
      throw new Error("无效的股票代码");
    }
    return { id: (data as { id: string }).id };
  })
  .handler(async ({ data }) => {
    const rows = await fetchLifts(data.id.replace(/^(sh|sz|bj)/, ""));
    return upcomingLifts(rows, new Date().toISOString().slice(0, 10));
  });

/** 给页面用的股指期货持仓。没有参数。单位是手。 */
export const getIndexFutures = createServerFn({ method: "GET" }).handler(async () => loadIndexFutures());

/**
 * 顶栏全局搜索（⌘K）。按名称或六位代码在全市场里找，最多 8 条。
 * 空查询直接回空，不拉行情——省得每次点开下拉都去请求一遍。
 * 港/美（M1/M2）：A 股名单里没有它们，字母/五位数字查询另走东财联想接口合并进来。
 */
export const getQuickSearch = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const q =
      typeof data === "object" && data !== null && "q" in data && typeof (data as { q?: unknown }).q === "string"
        ? (data as { q: string }).q.trim().slice(0, 20)
        : "";
    return { q };
  })
  .handler(async ({ data }) => {
    const empty = { matches: [] as { id: string; code: string; name: string; chg: number | null }[] };
    if (!data.q) return empty;
    const universe = await loadUniverse(false).catch(() => null);
    const needle = data.q.toLowerCase();
    const aMatches = (universe?.quotes ?? [])
      .filter((quote) => quote.name.toLowerCase().includes(needle) || quote.code.includes(needle))
      .slice(0, 8)
      .map((quote) => ({ id: quote.id, code: quote.code, name: quote.name, chg: quote.chg }));
    // 字母或五位数字才可能是港美股代码/拼音，中文两字以上也可能是港股名（腾讯→腾讯控股）。
    // 联想接口失败静默降级成纯 A 股结果，不让整个搜索挂掉。
    const overseasLooks = /^[A-Za-z.]{1,6}$/.test(data.q) || /^\d{5}$/.test(data.q) || /^[\u4e00-\u9fff]{2,}$/.test(data.q);
    if (!overseasLooks) return { matches: aMatches };
    const overseas = await searchOverseas(data.q).catch(() => []);
    const seen = new Set(aMatches.map((m) => m.id));
    const overseasMatches = overseas
      .filter((hit) => !seen.has(hit.id))
      .slice(0, 8 - aMatches.length)
      .map((hit) => ({ id: hit.id, code: hit.code, name: `${hit.name}（${hit.market === "hk" ? "港股" : "美股"}）`, chg: null as number | null }));
    return { matches: [...aMatches, ...overseasMatches] };
  });

/** 给页面用的日 K。传入 { id }，id 形状见 markets.ts:ID_PATTERN（A 股 sh/sz/bj + 六位，港 hk + 五位，美 us + 字母代码）。 */
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
    if (!ID_PATTERN.test(id)) throw new Error("无效的股票代码");
    return { id };
  })
  .handler(async ({ data }) => loadKline(data.id));

/** 港/美股报价（M1/M2）。东财港美行情域，拉不到带 why 让页面降级，不编造。 */
export const getOverseasQuote = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof (data as { id?: unknown }).id !== "string" ||
      marketOf((data as { id: string }).id) === "a"
    ) {
      throw new Error("无效的港美股代码");
    }
    return { id: (data as { id: string }).id };
  })
  .handler(async ({ data }) => {
    const quote = await fetchOverseasQuote(data.id).catch(() => null);
    return { quote, why: quote ? null : "港美股行情暂时拉不下来，稍后再试" };
  });

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

/**
 * 读当前用户的卖出提醒（顶栏铃铛 + Toast 的数据源）。
 *
 * data/sell-alerts.json 是记账进程的去重账本：每行 `用户id:日期:股票id:原因`，
 * 保证同一笔只提醒一次。这里没有"时间戳"，顺序就是记账顺序，新的在队尾。
 * 页面拿回去后按"已读水位"（最后一条的 key）切未读，水位存在浏览器里。
 * 原因：stop 止损 / target 目标价 / time 到期。
 */
export const getSellAlerts = createServerFn({ method: "GET" }).handler(async () => {
  const empty = { alerts: [] as SellAlert[] };
  try {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const userId = await requireUserId();
    const text = await readFile(join(process.cwd(), "data", "sell-alerts.json"), "utf8");
    const parsed = JSON.parse(text) as { sells?: unknown };
    if (!Array.isArray(parsed.sells)) return empty;
    const mine = parsed.sells.filter(
      (key): key is string => typeof key === "string" && key.startsWith(`${userId}:`),
    );
    if (mine.length === 0) return empty;
    // 带上股票名和卖出价：去账本里按 日期+id 找这笔成交。
    const book = await readUserBook<PaperDay>(userId).catch(() => null);
    const alerts = mine.slice(-20).reverse().map((key) => {
      const [, date = "", id = "", reason = ""] = key.split(":");
      const trade = book?.days.find((day) => day.date === date)?.trades.find((item) => item.id === id);
      return {
        key,
        date,
        id,
        reason: reason === "stop" ? "止损" : reason === "target" ? "目标价" : reason === "time" ? "到期" : reason,
        name: trade?.name ?? null,
        exit: trade?.exit ?? null,
      };
    });
    return { alerts };
  } catch {
    return empty;
  }
});

export type SellAlert = {
  /** 去重账本里的原值，当"已读水位"用：存最后一条的 key。 */
  key: string;
  date: string;
  id: string;
  reason: string;
  name: string | null;
  exit: number | null;
};

export type NavPoint = {
  date: string;
  /** 等权逐笔净值：1 + 所有笔平均收益（record-journal.ts 里定义，两边别各说各话）。 */
  nav: number;
  /** 沪深300 对首个记录交易日归一。index 缺失的旧点为 null，图上断开。 */
  benchmark: number | null;
};

/** 净值曲线。读不到文件/没登录都算空数组，页面显示空态而不是报错。 */
export const getNavHistory = createServerFn({ method: "GET" }).handler(async () => {
  const empty = { points: [] as NavPoint[] };
  try {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const userId = await requireUserId();
    const text = await readFile(join(process.cwd(), "data", "nav-history.json"), "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const mine = parsed[userId];
    if (!Array.isArray(mine)) return empty;
    const raw = mine as { date?: unknown; nav?: unknown; index?: unknown }[];
    // benchmark 在读取方对首个有 index 的点归一，写入方只记原始点位。
    const first = raw.find((p) => typeof p.index === "number" && p.index > 0);
    const firstIndex = first && typeof first.index === "number" ? first.index : null;
    const points = raw
      .filter((p) => typeof p.date === "string" && typeof p.nav === "number")
      .map((p) => {
        const index = typeof p.index === "number" && p.index > 0 ? p.index : null;
        return {
          date: p.date as string,
          nav: p.nav as number,
          benchmark: firstIndex != null && index != null ? index / firstIndex : null,
        };
      });
    return { points };
  } catch {
    return empty;
  }
});

/**
 * 读当前登录用户的交易日记。
 *
 * personal 表示是不是本人账本。why 是拿不到的原因——**必须带回去**：
 * 早先这里 catch 里直接返回空账本，页面于是回退去显示浏览器本地那份账，
 * 而本机那份是空的，于是出现「账本全是 0、当前持有 0 只」，看着像数据丢了。
 * 实际上服务端账本好好地在那儿（2026-10-05 查：2 天 71 笔），只是没登录到。
 * 页面要能说清「这是空账，因为拿不到你服务端的账」，就得知道原因。
 */
export const getServerJournal = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const userId = await requireUserId();
    await ensureUserBook(userId);
    const book = await readUserBook<PaperDay>(userId);
    return { days: book.days, personal: true as const, why: null as string | null };
  } catch (error) {
    // 记一条日志。静默返回空账本是 2026-10-05 下午查了三轮才定位到的原因：
    // 页面上只看到「当前持有 0 只」，服务端这边一点线索都没有。
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[journal] 服务端账本读不到：${message}`);
    const denied = /unauthorized|unauthenticated|401/i.test(message);
    return {
      days: [] as PaperDay[],
      personal: false as const,
      why: denied ? "没登录或登录状态过期" : message || "读服务端账本失败",
    };
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

// ── 预警微信推送（PushPlus）配置 ─────────────────────────────
// 推送只在记账进程为主人账号发声时触发，所以配置也只许主人动。
// token 是密钥：服务端只回「是否已配置 + 末四位」，完整值永远不出服务端。

const pushConfigPath = () => join(process.cwd(), "data", "push-config.json");

async function readPushToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(pushConfigPath(), "utf8"));
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

/** 推送配置状态。谁都能调（铃铛人人可见），非主人只回 allowed: false。 */
export const getPushStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return { allowed: false as const, configured: false, tail: null as string | null };
  const token = await readPushToken();
  return { allowed: true as const, configured: token != null, tail: token ? token.slice(-4) : null };
});

/** 保存/清除 PushPlus token。传空字符串 = 清除，回到只发 Mac 通知。 */export const savePushConfig = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (typeof data !== "object" || data == null || typeof (data as { token?: unknown }).token !== "string") {
      throw new Error("token 没填对");
    }
    return { token: (data as { token: string }).token.trim() };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能改推送配置");
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await writeFile(pushConfigPath(), JSON.stringify({ token: data.token }, null, 2));
    return { ok: true as const, configured: data.token !== "", tail: data.token ? data.token.slice(-4) : null };
  });

// ── AI 因子管理（/factors 页的「AI 因子管理」区块）────────────────
// AI 只许提议因子进待验队列：表达式进 factor-expr 白名单编译器，不碰判决逻辑、
// 不碰持仓下单。apiKey 是密钥：服务端只回尾四位，完整值不出服务端。
// factor-queue 有 node:fs——和 factor-runs-file 一样只活在这条 server fn 里，别打进组件。

/** 待验队列（AI/人工预登记的因子 + 淘汰状态）。 */
export const getFactorQueue = createServerFn({ method: "GET" }).handler(async () => readQueue());

/** AI 接口配置状态：档案列表（key 只回尾号）+ 启用中那套 + 自动进化开关。谁都能调，非主人只回 allowed: false。 */
export const getAIStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const { readAIPrefs } = await import("@/lib/market/ai-prefs");
  const { getActiveConfig } = await import("@/lib/market/ai-profiles");
  const userId = await requireUserId();
  const [prefs, profiles] = await Promise.all([readAIPrefs(), readProfiles()]);
  const { fallbackCandidates } = await import("@/lib/market/factor-queue");
  const base = {
    autoEvolve: prefs.autoEvolve,
    activeId: profiles.activeId,
    profiles: profiles.profiles.map(profileStatus),
    // 主备切换链（和 callAIWithFallback 同一个纯函数，不另写一遍）：主档案超时/
    // 报错按这个顺序自动切，封顶两个。只回名字+模型，key 照旧不出服务端。
    fallbackOrder: fallbackCandidates(profiles).map((c) => {
      const p = profiles.profiles.find((x) => x.id === c.profileId);
      return p ? `${p.name}（${p.model}）` : c.profileId;
    }),
    ...(await aiStatus(await getActiveConfig(profiles))),
  };
  if (userId !== OWNER_ID) return { allowed: false as const, ...base };
  return { allowed: true as const, ...base };
});

/** 新建/更新接口档案。id 空 = 新建；apiKey 留空 = 保留旧 key。 */
export const saveAIProfile = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as {
      id?: unknown;
      name?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      model?: unknown;
      pricePromptPerM?: unknown;
      priceCompletionPerM?: unknown;
    };
    if (typeof d?.name !== "string" || typeof d?.baseUrl !== "string" || typeof d?.apiKey !== "string" || typeof d?.model !== "string") {
      throw new Error("档案没填对（name / baseUrl / apiKey / model 都要是字符串）");
    }
    const optPrice = (v: unknown): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string") throw new Error("单价要是字符串（元/百万 tokens），不填就不算费用");
      return v;
    };
    return {
      id: typeof d.id === "string" && d.id ? d.id : undefined,
      name: d.name,
      baseUrl: d.baseUrl,
      apiKey: d.apiKey,
      model: d.model,
      pricePromptPerM: optPrice(d.pricePromptPerM),
      priceCompletionPerM: optPrice(d.priceCompletionPerM),
    };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const { upsertProfile, writeProfiles } = await import("@/lib/market/ai-profiles");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能改 AI 接口档案");
    const result = upsertProfile(await readProfiles(), data, new Date().toISOString());
    if (!result.ok) throw new Error(result.error);
    await writeProfiles(result.file);
    return { ok: true as const, profile: profileStatus(result.profile), activeId: result.file.activeId };
  });

/** 删除接口档案。删掉启用中的那套后 activeId 清空（闭环停在未配置）。 */
export const deleteAIProfile = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { id?: unknown };
    if (typeof d?.id !== "string" || !d.id) throw new Error("id 缺失");
    return { id: d.id };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const { removeProfile, writeProfiles } = await import("@/lib/market/ai-profiles");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能改 AI 接口档案");
    const file = removeProfile(await readProfiles(), data.id);
    await writeProfiles(file);
    return { ok: true as const, activeId: file.activeId };
  });

/** 启用某套档案（闭环立刻切到它）；传 null 停用全部。 */
export const setActiveAIProfile = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { id?: unknown };
    if (d?.id !== null && typeof d?.id !== "string") throw new Error("id 必须是字符串或 null");
    return { id: d.id };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const { setActiveProfile, writeProfiles } = await import("@/lib/market/ai-profiles");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能改 AI 接口档案");
    const file = setActiveProfile(await readProfiles(), data.id);
    await writeProfiles(file);
    return { ok: true as const, activeId: file.activeId };
  });

/** 从 OpenAI 兼容接口拉模型清单（/models），给弹窗里的模型下拉用。Ollama 的 {models:[{name}]} 和 OpenAI 的 {data:[{id}]} 都认。 */
export const listAIModels = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { baseUrl?: unknown; apiKey?: unknown };
    if (typeof d?.baseUrl !== "string" || typeof d?.apiKey !== "string") throw new Error("baseUrl / apiKey 没填对");
    return { baseUrl: d.baseUrl.trim().replace(/\/+$/, ""), apiKey: d.apiKey.trim() };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能拉模型清单");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(`${data.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${data.apiKey}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`接口 HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
      const ids = [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.name)].filter((v): v is string => typeof v === "string" && v.length > 0);
      return { ok: true as const, models: [...new Set(ids)].slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  });

/** 测一个接口通不通：最小一轮对话 + 计时 + 按填的单价算本次费用。不入 ai-log（不算进化轮）。 */
export const testAIProfile = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { baseUrl?: unknown; apiKey?: unknown; model?: unknown; pricePromptPerM?: unknown; priceCompletionPerM?: unknown };
    if (typeof d?.baseUrl !== "string" || typeof d?.apiKey !== "string" || typeof d?.model !== "string") {
      throw new Error("baseUrl / apiKey / model 没填对");
    }
    const optPrice = (v: unknown): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("单价要是非负数");
      return n;
    };
    return {
      baseUrl: d.baseUrl.trim(),
      apiKey: d.apiKey.trim(),
      model: d.model.trim(),
      pricePromptPerM: optPrice(d.pricePromptPerM),
      priceCompletionPerM: optPrice(d.priceCompletionPerM),
    };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能测接口");
    const { callAI } = await import("@/lib/market/factor-queue");
    const started = Date.now();
    try {
      await callAI(
        { baseUrl: data.baseUrl.replace(/\/+$/, ""), apiKey: data.apiKey, model: data.model },
        "连通性测试：只回复 ok 两个字母。",
        { layer: "test", trigger: "test", pricePromptPerM: data.pricePromptPerM, priceCompletionPerM: data.priceCompletionPerM },
      );
      return { ok: true as const, ms: Date.now() - started };
    } catch (error) {
      return { ok: false as const, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  });

/** 让 AI 跑一轮闭环：读最近判决 → 提议新因子 → 校验后进队列。 */
export const runFactorAI = createServerFn({ method: "POST" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) throw new Error("只有主人账号能跑 AI 闭环");
  const { FACTORS } = await import("@/lib/market/factors");
  return runFactorAILoop({
    readRows: readFactorRuns,
    existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })),
  });
});

// ── 策略层 AI 管理（/positions 策略追踪页的「AI 挑战者」面板）────
// AI 只许提名挑战者（出场参数旋钮），转正/淘汰由 record-journal 里预先登记的
// Welch 判决说了算。配置和因子层共用同一份 data/ai-config.json。

/** 挑战者名单 + 各策略当前冠军参数。 */
export const getChallengers = createServerFn({ method: "GET" }).handler(async () => {
  const { readChallengers, readChampions } = await import("@/lib/market/challenger");
  const [chal, champions] = await Promise.all([readChallengers(), readChampions()]);
  return { list: chal.list, champions };
});

/** 在跑挑战者各自攒到的已平仓样本数（判决要 30 笔，冠军那边也要 30 笔）。和记账进程同一个分桶口径。 */
export const getChallengerSamples = createServerFn({ method: "GET" }).handler(async () => {
  const { OWNER_ID, readUserBook } = await import("@/lib/market/book-file");
  const { bucketReturns, CHALLENGER_RULE, readChallengers } = await import("@/lib/market/challenger");
  const book = await readUserBook<{ signalTime?: string; trades: { entry?: number; exit?: number | null; style?: string; variant?: string }[] }>(OWNER_ID).catch(() => null);
  const buckets = bucketReturns(book?.days ?? []);
  const { list } = await readChallengers();
  const counts: Record<string, { n: number; target: number; champN: number }> = {};
  for (const c of list) {
    if (c.status !== "running") continue;
    counts[c.id] = {
      n: (buckets.get(`${c.style}:${c.id}`) ?? []).length,
      target: CHALLENGER_RULE.minTrades,
      // Welch 判决是双样本检验：挑战者和冠军两边各攒够 minTrades 才判，单边够数不算数
      champN: (buckets.get(`${c.style}:champion`) ?? []).length,
    };
  }
  return counts;
});

/** 让 AI 提名一轮挑战者：校验通过的直接 running，记账进程当天开始并行攒样本。 */
export const runStrategyAI = createServerFn({ method: "POST" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) throw new Error("只有主人账号能跑 AI 闭环");
  const { runStrategyAILoop } = await import("@/lib/market/strategy-ai");
  return runStrategyAILoop();
});

/** 一键完整进化：因子层 → 策略层各跑一轮，两层各自记账（ai-log）。 */
export const runEvolve = createServerFn({ method: "POST" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) throw new Error("只有主人账号能跑 AI 进化");
  const { runEvolveLoop } = await import("@/lib/market/evolve");
  const { FACTORS } = await import("@/lib/market/factors");
  return runEvolveLoop({
    readRows: readFactorRuns,
    existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })),
  });
});

/** AI 运行账本（自我进化历史）。非主人只回 allowed: false。 */
export const getAILog = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return { allowed: false as const, entries: [] as Awaited<ReturnType<typeof readAILog>> };
  return { allowed: true as const, entries: await readAILog() };
});

// ── AI 大脑诊断层（agent-loop.ts，design/AI-BRAIN.md 方案 A 第一步）──
// 只诊断不行动：读整个账本出报告，规则变更只生成请求给人拍板。

/** 最近一次全局诊断报告（agent-diagnosis.json）。非主人回 null。 */
export const getAgentDiagnosis = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return null;
  const { readAgentDiagnosis } = await import("@/lib/market/agent-loop");
  return readAgentDiagnosis();
});

/** 手动跑一轮全局诊断：结果落 agent-diagnosis.json + ai-log（layer=agent）。 */
export const runAgentDiagnose = createServerFn({ method: "POST" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) throw new Error("只有主人账号能跑 AI 诊断");
  const { runAgentDiagnosis } = await import("@/lib/market/agent-loop");
  return runAgentDiagnosis("manual");
});

// ── Vibe-Trading MCP 工具矿山（vt-tools.ts，design/AI-BRAIN.md 方案 B）──
// 74 个只读研究工具，stdio 子进程随用随起；shell 工具 VT 侧默认就不注册。

/** VT 工具矿山状态（在线 / 工具数 / 清单）。非主人回 allowed: false。带 5 分钟缓存。 */
export const getVTToolsStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return { allowed: false as const };
  const { checkVTTools } = await import("@/lib/market/vt-tools");
  return { allowed: true as const, status: await checkVTTools() };
});

/** token 用量账（监控控制台）。非主人只回 allowed: false。 */
export const getAIUsage = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const { readAIUsage, usageStats } = await import("@/lib/market/ai-usage");
  const { readProfiles } = await import("@/lib/market/ai-profiles");
  const { referencePriceOf } = await import("@/lib/market/ai-prices");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return { allowed: false as const, entries: [], stats: null };
  const entries = await readAIUsage();
  // 历史未计价条目的现价估算：先按条目记的 profileId 找档案现价（模型名对得上
  // 才用——换过模型的档案，旧模型的账不能套新价），对不上再查内置参考价目表。
  const profiles = (await readProfiles().catch(() => ({ activeId: null, profiles: [] as never[] }))).profiles as {
    id: string; model: string; pricePromptPerM: number | null; priceCompletionPerM: number | null;
  }[];
  const stats = usageStats(entries, new Date().toISOString().slice(0, 10), (entry) => {
    const profile = profiles.find((p) => p.id === entry.profileId);
    if (profile && profile.model === entry.model && (profile.pricePromptPerM != null || profile.priceCompletionPerM != null)) {
      return { prompt: profile.pricePromptPerM ?? 0, completion: profile.priceCompletionPerM ?? 0 };
    }
    return referencePriceOf(entry.model);
  });
  return { allowed: true as const, entries, stats };
});

/** 决策者记分牌（decision-ledger.ts）：AI 提议 vs 人工登记的过关/淘汰对照。 */
export const getDecisionLedger = createServerFn({ method: "GET" }).handler(async () => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const { OWNER_ID } = await import("@/lib/market/book-file");
  const { readDecisionLedger } = await import("@/lib/market/decision-ledger");
  const userId = await requireUserId();
  if (userId !== OWNER_ID) return { allowed: false as const, ledger: null };
  return { allowed: true as const, ledger: await readDecisionLedger() };
});

/** 闸门面板（system-rules.ts）：五组判据常量的当前值。只读，改阈值去改各自 RULE。 */
export const getSystemRules = createServerFn({ method: "GET" }).handler(async () => ({
  groups: systemRules(),
}));

/**
 * 按页面选的参数跑一轮因子检验（BT_FACTOR 分支）。owner 专属——它会写
 * factor-runs.jsonl 和待验队列，不是看看就完的事。可调的只有四个采样参数，
 * 判据和注册表碰不到（factor-test-runner.ts 文件头写了纪律）。
 */
export const runFactorTest = createServerFn({ method: "POST" })
  .validator((data: unknown) => sanitizeParams(data))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能发起因子检验");
    const { runFactorTest: run } = await import("@/lib/market/factor-test-runner");
    return run(data);
  });

/** 保存 AI 偏好开关（目前只有 autoEvolve：收盘后每天自动跑一轮进化）。 */
export const saveAIPrefs = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { autoEvolve?: unknown };
    if (typeof d?.autoEvolve !== "boolean") throw new Error("autoEvolve 必须是布尔");
    return { autoEvolve: d.autoEvolve };
  })
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const { OWNER_ID } = await import("@/lib/market/book-file");
    const { writeAIPrefs } = await import("@/lib/market/ai-prefs");
    const { resetBreaker } = await import("@/lib/market/evolve-breaker");
    const userId = await requireUserId();
    if (userId !== OWNER_ID) throw new Error("只有主人账号能改 AI 开关");
    await writeAIPrefs(data);
    // 重新打开自动进化 = 人来看过了。清零熔断计数、解除断电记录，
    // 不然下一轮还在「已熔断」的旧账上计。
    if (data.autoEvolve) await resetBreaker();
    return { ok: true as const, autoEvolve: data.autoEvolve };
  });

// ── 因子研究页（/factors）的三个数据源 ──────────────────────────
// 这三条读的都是 data/backtest/ 下的本地产物。data/ 在 .gitignore 里，
// 线上和新机器必然读不到——所以读不到要带回 why，让页面说「还没跑」并给重跑命令，
// 绝不能返回空集合冒充「0 个因子」。

/** 最近一次因子 6 关判决。 */
/** 6 关判决。可传 batch（批次索引，0=最旧，缺省/负数=最新）回看任意一批。 */
export const getFactorRuns = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const b = typeof data === "object" && data !== null && "batch" in data ? (data as { batch?: unknown }).batch : undefined;
    return { batch: typeof b === "number" && Number.isInteger(b) ? b : -1 };
  })
  .handler(async ({ data }) => readFactorRuns(data.batch));


/** 缩量天数归因 + 资金流探路。 */
export const getFactorDiag = createServerFn({ method: "GET" }).handler(async () => readFactorDiag());

/** 回测基线原文（纯文本，不做任何解析）。 */
export const getFactorBaseline = createServerFn({ method: "GET" }).handler(async () => readBaseline());

// ── 策略级自动闸门状态（data/strategy-gates.json）────────────────
// 记账进程按 STRATEGY_GATE（strategy-gate.ts，预先登记的标准）判决后落盘，
// 这里只读不改。选股页左侧面板用它给被停用的策略挂「已停用 / 假释中」标记——
// 不然那套策略只是「永远没有票」，看起来像坏了。

/** 一套策略的闸门状态。reason 是判决那天的依据原文。 */
export type StrategyGate = {
  state: "disabled" | "paroled";
  since: string;
  cooldownDays: number;
  strikes: number;
  reason: string;
};

export const getStrategyGates = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const text = await readFile(join(process.cwd(), "data", "strategy-gates.json"), "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { gates: parsed as Record<string, StrategyGate> };
    }
  } catch {
    // 没有文件 = 没有策略被停用，正常。
  }
  return { gates: {} as Record<string, StrategyGate> };
});
