/**
 * 这个文件是干什么的：
 * 东方财富行情源，腾讯的备份。拉全市场 A 股快照和常用指数现价。
 *
 * 你需要知道的：
 * 和腾讯的口径差异：市盈率是动态 PE（腾讯是 TTM）；没有近 5/10/20/60 日和
 * 今年涨跌幅，这些字段给 null；振幅用最高最低和昨收现算。东财的市值单位是
 * 元（换成亿元），主力净流入和成交额也是元（换成万元），和 types.ts 对齐。
 * 单页最多返回 100 条，全市场要翻约 60 页，并发 5 路拉。
 */

import type { IndexQuote, Quote } from "@/lib/market/types";
import { boardOf, isSt, mapPool, num } from "@/lib/market/providers/shared";

const HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://quote.eastmoney.com/",
  accept: "application/json,text/plain,*/*",
};

/** 沪深京 A 股的筛选式：深市主板+创业板、沪市主板+科创板、北交所。 */
const FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const FIELDS = "f12,f13,f14,f2,f3,f9,f23,f20,f21,f8,f10,f6,f62,f15,f16,f18";
const PAGE = 100;

type Raw = Record<string, unknown>;

/** 东财的市场代码：1 是沪市；0 是深市，北交所也混在 0 里，要靠代码段分（4、8、92 开头是北证）。 */
function toId(f13: unknown, code: string): string | null {
  if (f13 === 1) return `sh${code}`;
  if (f13 === 0) {
    if (/^(4|8|92)/.test(code)) return `bj${code}`;
    return `sz${code}`;
  }
  return null;
}

function toQuote(raw: Raw): Quote | null {
  const code = typeof raw.f12 === "string" ? raw.f12 : "";
  if (!/^\d{6}$/.test(code)) return null;
  const id = toId(raw.f13, code);
  if (!id) return null;
  if (id.startsWith("sh900") || id.startsWith("sz200")) return null;
  const name = typeof raw.f14 === "string" && raw.f14.trim() ? raw.f14.trim() : id;
  const price = num(raw.f2, "any") ?? 0;
  const prev = num(raw.f18, "any");
  const high = num(raw.f15, "any");
  const low = num(raw.f16, "any");
  const amp = prev && high != null && low != null ? ((high - low) / prev) * 100 : 0;
  return {
    id,
    code,
    name,
    board: boardOf(id, ""),
    price,
    chg: num(raw.f3, "pct"),
    pe: num(raw.f9, "ratio"),
    pb: num(raw.f23, "ratio"),
    cap: (num(raw.f20, "any") ?? 0) / 1e8,
    floatCap: (num(raw.f21, "any") ?? 0) / 1e8,
    turnover: num(raw.f8, "any") ?? 0,
    volRatio: num(raw.f10, "any") ?? 0,
    amp,
    d5: null,
    d10: null,
    d20: null,
    d60: null,
    ytd: null,
    inflow: (num(raw.f62, "any") ?? 0) / 1e4,
    amount: (num(raw.f6, "any") ?? 0) / 1e4,
    st: isSt(name),
  };
}

async function fetchPage(pn: number): Promise<{ list: Raw[]; total: number }> {
  const url =
    "https://push2.eastmoney.com/api/qt/clist/get" +
    `?pn=${pn}&pz=${PAGE}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${FS}&fields=${FIELDS}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { rc?: number; data?: { total?: number; diff?: Raw[] } | null };
  const list = body.data?.diff;
  if (!Array.isArray(list)) throw new Error("bad payload");
  return { list, total: body.data?.total ?? list.length };
}

/** 拉全市场 A 股快照。接口限每页 100 条，先拉第一页拿到总数，再并发翻完剩下的页。 */
export async function fetchEastmoneyUniverse(): Promise<{ quotes: Quote[]; partial: boolean }> {
  const first = await fetchPage(1);
  const pages: number[] = [];
  for (let pn = 2; pn <= Math.ceil(first.total / PAGE); pn += 1) pages.push(pn);
  const rest = await mapPool(pages, 5, async (pn) => {
    try {
      return (await fetchPage(pn)).list;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 280));
      return (await fetchPage(pn)).list;
    }
  });
  const byId = new Map<string, Quote>();
  for (const raw of first.list.concat(...rest)) {
    const quote = toQuote(raw);
    if (!quote || byId.has(quote.id)) continue;
    byId.set(quote.id, quote);
  }
  return { quotes: [...byId.values()], partial: false };
}

/** 拉常用指数现价。ids 是 sh、sz 加六位代码，内部换成东财的 1./0. 前缀。 */
export async function fetchEastmoneyIndices(ids: readonly string[]): Promise<IndexQuote[]> {
  const secids = ids.map((id) => `${id.startsWith("sh") ? "1" : "0"}.${id.slice(2)}`).join(",");
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f3,f4`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: { diff?: Raw[] } | null };
  const list = body.data?.diff;
  if (!Array.isArray(list) || list.length === 0) throw new Error("index empty");
  const rows: IndexQuote[] = [];
  for (const raw of list) {
    const code = typeof raw.f12 === "string" ? raw.f12 : "";
    const secid = ids.find((id) => id.slice(2) === code);
    const price = num(raw.f2, "any");
    if (!secid || price == null) continue;
    rows.push({
      id: secid,
      name: typeof raw.f14 === "string" && raw.f14 ? raw.f14 : secid,
      price,
      chg: num(raw.f4, "any") ?? 0,
      pct: num(raw.f3, "pct") ?? 0,
      time: "",
    });
  }
  if (rows.length === 0) throw new Error("index empty");
  return rows;
}
