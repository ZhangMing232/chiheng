/**
 * 这个文件是干什么的：
 * 新浪财经行情源，腾讯之外的另一路全市场 A 股快照备份。
 *
 * 你需要知道的：
 * 东财的全市场名单接口（clist）在本机网络下连不通（同域名的指数接口正常），
 * 所以备份源换成新浪。接口是 Market_Center.getHQNodeData，按 symbol 排序翻页，
 * 每页 100 条，翻到空页为止，并发 5 路。symbol 自带 sh/sz/bj 前缀，直接当内部编号。
 * 和腾讯的口径差异：没有量比和主力净流入（给 0）；近 5/10/20/60 日和今年涨跌幅
 * 给 null；市值单位是万元（换成亿元），成交额是元（换成万元），和 types.ts 对齐。
 */

import type { Quote } from "@/lib/market/types";
import { boardOf, isSt, mapPool, num } from "@/lib/market/providers/shared";

const HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://finance.sina.com.cn/",
  accept: "application/json,text/plain,*/*",
};

const BASE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";
const PAGE = 100;
/** 翻页保险上限：现在全市场约 5900 只，100 条一页不到 60 页，留够余量。 */
const MAX_PAGES = 80;

type Raw = Record<string, unknown>;

/** 把新浪的一行原始数据转成内部行情形状。解析不了的行返回 null。 */
export function parseSinaQuote(raw: Raw): Quote | null {
  const id = typeof raw.symbol === "string" ? raw.symbol : "";
  if (!/^(sh|sz|bj)\d{6}$/.test(id)) return null;
  if (id.startsWith("sh900") || id.startsWith("sz200")) return null;
  const code = typeof raw.code === "string" && /^\d{6}$/.test(raw.code) ? raw.code : id.slice(2);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const price = num(raw.trade, "any") ?? 0;
  const prev = num(raw.settlement, "any");
  const high = num(raw.high, "any");
  const low = num(raw.low, "any");
  const amp = prev && high != null && low != null ? ((high - low) / prev) * 100 : 0;
  return {
    id,
    code,
    name,
    board: boardOf(id, ""),
    price,
    chg: num(raw.changepercent, "pct"),
    pe: num(raw.per, "ratio"),
    pb: num(raw.pb, "ratio"),
    cap: (num(raw.mktcap, "any") ?? 0) / 1e4,
    floatCap: (num(raw.nmc, "any") ?? 0) / 1e4,
    turnover: num(raw.turnoverratio, "any") ?? 0,
    volRatio: 0,
    amp,
    d5: null,
    d10: null,
    d20: null,
    d60: null,
    ytd: null,
    inflow: 0,
    amount: (num(raw.amount, "any") ?? 0) / 1e4,
    st: isSt(name),
  };
}

async function fetchPage(page: number): Promise<Raw[]> {
  const url = `${BASE}?page=${page}&num=${PAGE}&sort=symbol&asc=1&node=hs_a&symbol=`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error("bad payload");
  return body as Raw[];
}

/** 重试一次；两次都失败的页返回空并标记缺页，不让一整页拖垮全市场。 */
async function fetchPageSafe(page: number): Promise<{ rows: Raw[]; ok: boolean }> {
  try {
    return { rows: await fetchPage(page), ok: true };
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 280));
    try {
      return { rows: await fetchPage(page), ok: true };
    } catch {
      return { rows: [], ok: false };
    }
  }
}

/**
 * 拉全市场 A 股快照。接口不返回总数，先拉第一页，再乐观并发翻完后面的页，
 * 空页即收尾。某一页彻底失败会标 partial，由调用方按名单完整度决定是否采用。
 */
export async function fetchSinaUniverse(): Promise<{ quotes: Quote[]; partial: boolean }> {
  const first = await fetchPage(1);
  if (first.length === 0) throw new Error("名单为空");
  const pages: number[] = [];
  for (let page = 2; page <= MAX_PAGES; page += 1) pages.push(page);
  const rest = await mapPool(pages, 5, fetchPageSafe);
  const byId = new Map<string, Quote>();
  let partial = false;
  for (const raw of first) {
    const quote = parseSinaQuote(raw);
    if (quote) byId.set(quote.id, quote);
  }
  for (const { rows, ok } of rest) {
    if (!ok) partial = true;
    for (const raw of rows) {
      const quote = parseSinaQuote(raw);
      if (quote && !byId.has(quote.id)) byId.set(quote.id, quote);
    }
  }
  return { quotes: [...byId.values()], partial };
}
