/**
 * 这个文件是干什么的：
 * 港股/美股行情页（/overseas）的服务端接口。**只做行情，不接策略**
 * （用户 2026-10-14 明确「不用策略，只要行情能看数据」）。
 *
 * 你需要知道的：
 * 1. **按需分页，不做全市场缓存**。港股 17429 + 美股 13854 = 3 万只，一次拉不完
 *    也没必要（实测接口都通：A 股是一次拉全市场 4606，港美走同一接口但只取一页）。
 * 2. **东财有风控**：串行 + 间隔查 fetch-policy（港美域在 eastmoney 名下）。
 *    指数那块 2026-11-07 改成「一次批量 + 两次批量之间节流」，别在循环里逐个 sleep：
 *    6 次 sleep×1300ms 实测把首页 SSR 拖到 9~24 秒才出首字节。
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
import { OVERSEAS_INDICES, parseOverseasIndexBatch, type OverseasIndexQuote } from "@/lib/market/overseas-index-batch";

const UA = "Mozilla/5.0";
const LIST_URL = "https://push2.eastmoney.com/api/qt/clist/get";
const KLINE_URL = "https://push2.eastmoney.com/api/qt/stock/kline/get";

/** 东财市场筛选串。港股 116；美股 105/106/107 是三个交易所。 */
const FS: Record<OverseasMarket, string> = { hk: "m:116", us: "m:105,m:106,m:107" };

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

/** 一批港美指数的行情：一次批量拉 6 个，解析与口径见 overseas-index-batch.ts。 */
export type IndexQuote = OverseasIndexQuote;

const INDEX_BATCH_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const INDEX_BATCH_FIELDS = "f2,f3,f12,f13,f14,f18";

/**
 * 指数改成批量后只剩「一次请求」，限速语义从「循环里每两个之间 sleep」变成
 * 「两次批量之间至少隔 minGapMs」：模块级时间戳，防首页和 /overseas 并发打爆东财。
 * 首次调用不等待——这是首页 SSR 从 9 秒降到毫秒级的关键。
 */
let lastIndexBatchAt = 0;
async function fetchIndexBatch(): Promise<unknown> {
  const gap = rateLimitOf("eastmoney").minGapMs;
  const wait = lastIndexBatchAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastIndexBatchAt = Date.now();
  const secids = OVERSEAS_INDICES.map((item) => item.secid).join(",");
  return getJson(
    `${INDEX_BATCH_URL}?secids=${secids}&ut=fa5fd1943c7b386f172d6893dbfba10b&fltt=2&invt=2&fields=${INDEX_BATCH_FIELDS}`,
  );
}

export const getOverseasIndices = createServerFn({ method: "GET" }).handler(async (): Promise<{
  quotes: IndexQuote[];
  gaps: string[];
}> => parseOverseasIndexBatch(await fetchIndexBatch()));

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