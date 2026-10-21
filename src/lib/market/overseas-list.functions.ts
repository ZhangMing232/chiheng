/**
 * 这个文件是干什么的：
 * 港股/美股行情页（/overseas）的服务端接口。**只做行情，不接策略**
 * （用户 2026-10-14 明确「不用策略，只要行情能看数据」）。
 *
 * 你需要知道的：
 * 1. **按需分页，不做全市场缓存**。港股 17429 + 美股 13854 = 3 万只，一次拉不完
 *    也没必要（实测接口都通：A 股是一次拉全市场 4606，港美走同一接口但只取一页）。
 * 2. **东财有风控**：串行 + 间隔查 fetch-policy（港美域在 eastmoney 名下）。
 * 3. 指数跨两个域（恒生/国企/道指/纳指/标普在 100，**恒生科技在 124**），
 *    这条实测踩过：按恒生系列的直觉写成 100.HSTECH 返回 null。
 * 4. 自选那几行是逐只拉的（串行限速），只拉 hk / us 前缀的，A 股自选不走这里。
 */

import { createServerFn } from "@tanstack/react-start";
import {
  FID,
  OVERSEAS_PAGE_SIZE,
  parseOverseasList,
  type OverseasMarket,
  type OverseasRow,
  type OverseasSort,
} from "./overseas-list.ts";
import { rateLimitOf } from "./fetch-policy.ts";
import { readWatchlist } from "./watchlist.ts";
import { secidOf } from "./providers/overseas.ts";
import { parseQuote, type OverseasQuote } from "./providers/overseas.ts";
import { currencyLabelOf } from "./markets.ts";

const UA = "Mozilla/5.0";
const LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const KLINE_URL = "https://push2.eastmoney.com/api/qt/stock/kline/get";

/** 东财市场筛选串。港股 116；美股 105/106/107 是三个交易所。 */
const FS: Record<OverseasMarket, string> = { hk: "m:116", us: "m:105,m:106,m:107" };

function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export type ListPayload = {
  rows: OverseasRow[];
  /** 该市场总只数（东财给的） */
  total: number;
  page: number;
  size: number;
  /** 这一页里有几只解析不出来 */
  bad: number;
  why: string | null;
};

/** 港股或美股的全市场行情，一页 100 只。 */
export const getOverseasList = createServerFn({ method: "GET" })
  .validator((input: unknown): { market: OverseasMarket; page: number; sort: OverseasSort } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const market: OverseasMarket = v.market === "us" ? "us" : "hk";
    const page = typeof v.page === "number" && v.page >= 1 ? Math.min(Math.round(v.page), 200) : 1;
    const sort: OverseasSort = v.sort === "price" || v.sort === "amount" || v.sort === "code" ? v.sort : "chg";
    return { market, page, sort };
  })
  .handler(async ({ data }): Promise<ListPayload> => {
    const po = data.sort === "code" ? 0 : 1;
    const url =
      `${LIST_URL}?pn=${data.page}&pz=${OVERSEAS_PAGE_SIZE}&po=${po}&np=1&fltt=2&invt=2&fid=${FID[data.sort]}` +
      `&fs=${FS[data.market]}&fields=f2,f3,f4,f6,f12,f13,f14`;
    const body = await getJson(url);
    const parsed = parseOverseasList(body);
    return {
      rows: parsed.rows,
      total: parsed.total,
      page: data.page,
      size: OVERSEAS_PAGE_SIZE,
      bad: parsed.bad,
      why: parsed.rows.length === 0 ? `拉不到${data.market === "hk" ? "港股" : "美股"}行情（东财没返回或返回体不对）` : null,
    };
  });

/** 一批港美指数的行情。跨 100 和 124 两个域，逐个拉（串行限速）。 */
export type IndexQuote = { id: string; name: string; price: number | null; chg: number | null; secid: string };

/**
 * 指数点位要 ÷100 还原。实测（2026-10-14）：道指 5167010 → 51670.10、
 * 纳指 2720438 → 27204.38、标普 780545 → 7805.45、恒生 2434522 → 24345.22，
 * 都是真实点位。东财没给指数的 decimal 标记（f59 是 null），所以写死 ÷100。
 *
 * 涨跌幅**不**用 f170（那也要 ÷100，错了就错 100 倍），改成用现价和昨收算比例——
 * 缩放无关，÷100 写错了也只是点位显示错，涨跌幅不会跟着错。
 *
 * 指数的 kline 接口（push2his/stock/kline）对 100/124 域返回 `klines: []`
 * （dktotal=0），所以指数只能拿现价+昨收，拿不到日内走势。要走势图得另找源。
 */
const INDEX_SCALE = 100;

const INDICES: { id: string; secid: string }[] = [
  { id: "hsi", secid: "100.HSI" },
  { id: "hscei", secid: "100.HSCEI" },
  // 恒生科技在 124 域。按恒生系列的直觉写成 100.HSTECH 实测返回 null。
  { id: "hstech", secid: "124.HSTECH" },
  { id: "djia", secid: "100.DJIA" },
  { id: "ndx", secid: "100.NDX" },
  { id: "spx", secid: "100.SPX" },
];

export const getOverseasIndices = createServerFn({ method: "GET" }).handler(async (): Promise<{
  quotes: IndexQuote[];
  gaps: string[];
}> => {
  const gap = rateLimitOf("eastmoney").minGapMs;
  const quotes: IndexQuote[] = [];
  const gaps: string[] = [];
  for (const item of INDICES) {
    const url =
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${item.secid}` +
      `&ut=fa5fd1943c7b386f172d6893dbfba10b&fields=f57,f58,f43,f60`;
    const body = (await getJson(url)) as { data?: Record<string, unknown> } | null;
    const data = body?.data ?? null;
    const raw = numOf(data?.f43);
    const prev = numOf(data?.f60);
    const name = typeof data?.f58 === "string" ? data.f58 : item.id;
    if (raw == null || prev == null) {
      // 港股指数在非交易时段 f43 给 0（只有昨收）。这不是「没这只指数」，
      // 是「现在没有新价格」——说清楚，别显示成 0 点位。
      gaps.push(
        prev != null && raw === 0
          ? `${name} 这会儿没有新价格（只有昨收 ${(prev / INDEX_SCALE).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}，多半是休市）`
          : `${name}（${item.secid}）没拉到`,
      );
      quotes.push({ id: item.id, name, price: prev != null ? prev / INDEX_SCALE : null, chg: null, secid: item.secid });
    } else {
      quotes.push({
        id: item.id,
        name,
        price: raw / INDEX_SCALE,
        chg: prev > 0 ? ((raw - prev) / prev) * 100 : null,
        secid: item.secid,
      });
    }
    await new Promise((r) => setTimeout(r, gap));
  }
  return { quotes, gaps };
});

export type WatchQuoteRow = OverseasQuote & { currency: string };

/**
 * 自选里的港美票，逐只拉行情（串行限速）。
 * A 股自选不走这里——它有全市场快照，港美没有全市场缓存，只能一只一只问。
 */
export const getOverseasWatchQuotes = createServerFn({ method: "GET" }).handler(async (): Promise<{
  rows: WatchQuoteRow[];
  gaps: string[];
}> => {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  const userId = await requireUserId();
  const list = await readWatchlist(userId);
  const targets = list.items.filter((item) => item.id.startsWith("hk") || item.id.startsWith("us"));
  const gap = rateLimitOf("eastmoney").minGapMs;
  const rows: WatchQuoteRow[] = [];
  const gaps: string[] = [];
  for (const item of targets) {
    const secid = secidOf(item.id);
    if (!secid) {
      gaps.push(`${item.name}（${item.id}）的代码认不出来`);
      continue;
    }
    const url =
      `${KLINE_URL}?secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b` +
      `&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=2`;
    const body = (await getJson(url)) as { data?: Record<string, unknown> } | null;
    const quote = parseQuote(item.id, body?.data ?? null);
    if (!quote) {
      gaps.push(`${item.name}（${item.id}）这会儿拉不到报价`);
      continue;
    }
    rows.push({ ...quote, currency: currencyLabelOf(item.id) });
    await new Promise((r) => setTimeout(r, gap));
  }
  return { rows, gaps };
});