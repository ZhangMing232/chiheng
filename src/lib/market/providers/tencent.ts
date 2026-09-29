/**
 * 这个文件是干什么的：
 * 腾讯行情源。拉全市场 A 股报价（分页）和几只常用指数的现价。
 *
 * 你需要知道的：
 * 这是主源，字段最全（含近 5/10/20/60 日和今年涨跌幅）。市值单位是亿元，
 * 主力净流入和成交额单位是万元，和 types.ts 里的约定一致。
 */

import type { IndexQuote, Quote } from "@/lib/market/types";
import { boardOf, isSt, mapPool, num } from "@/lib/market/providers/shared";

type Raw = Record<string, string | undefined>;

const HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://stockapp.finance.qq.com/",
  accept: "application/json,text/plain,*/*",
};

function toQuote(raw: Raw): Quote | null {
  const id = raw.code ?? "";
  if (!/^(sh|sz|bj)\d{6}$/.test(id)) return null;
  if (id.startsWith("sh900") || id.startsWith("sz200")) return null;
  const name = raw.name?.trim() || id;
  const price = num(raw.zxj, "any") ?? 0;
  return {
    id,
    code: id.slice(2),
    name,
    board: boardOf(id, raw.stock_type ?? ""),
    price,
    chg: num(raw.zdf, "pct"),
    pe: num(raw.pe_ttm, "ratio"),
    pb: num(raw.pn, "ratio"),
    cap: num(raw.zsz, "any") ?? 0,
    floatCap: num(raw.ltsz, "any") ?? 0,
    turnover: num(raw.hsl, "any") ?? 0,
    volRatio: num(raw.lb, "any") ?? 0,
    amp: num(raw.zf, "pct") ?? 0,
    d5: num(raw.zdf_d5, "pct"),
    d10: num(raw.zdf_d10, "pct"),
    d20: num(raw.zdf_d20, "pct"),
    d60: num(raw.zdf_d60, "pct"),
    ytd: num(raw.zdf_y, "pct"),
    inflow: num(raw.zljlr, "any") ?? 0,
    amount: num(raw.turnover, "any") ?? 0,
    st: isSt(name),
  };
}

async function fetchPage(
  board: string,
  offset: number,
  count: number,
): Promise<{ list: Raw[]; total: number }> {
  const url =
    "https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList" +
    `?board_code=${board}&sort_type=price&direct=down&offset=${offset}&count=${count}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as {
    code?: number;
    msg?: string;
    data?: { rank_list?: Raw[]; total?: number };
  };
  const list = body.data?.rank_list;
  if (!Array.isArray(list)) {
    if ((body.msg ?? "").includes("count")) throw new Error("count");
    throw new Error(body.msg || "bad payload");
  }
  return { list, total: body.data?.total ?? list.length };
}

async function loadBoard(board: string, pageSize: number): Promise<Raw[]> {
  let size = pageSize;
  let first: { list: Raw[]; total: number };
  try {
    first = await fetchPage(board, 0, size);
  } catch (error) {
    if (error instanceof Error && error.message === "count" && size > 40) {
      size = 40;
      first = await fetchPage(board, 0, size);
    } else {
      throw error;
    }
  }
  const offsets: number[] = [];
  for (let offset = size; offset < first.total; offset += size) offsets.push(offset);
  const rest = await mapPool(offsets, 5, async (offset) => {
    try {
      return (await fetchPage(board, offset, size)).list;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 280));
      return (await fetchPage(board, offset, size)).list;
    }
  });
  return first.list.concat(...rest);
}

/** 拉全市场 A 股报价。主板和科创板分两个榜单，科创板拉不到时标 partial，不拖垮整份名单。 */
export async function fetchTencentUniverse(): Promise<{ quotes: Quote[]; partial: boolean }> {
  const main = await loadBoard("aStock", 200);
  let partial = false;
  let star: Raw[] = [];
  try {
    star = await loadBoard("ksh", 40);
  } catch {
    partial = true;
  }
  const byId = new Map<string, Quote>();
  for (const raw of main.concat(star)) {
    const quote = toQuote(raw);
    if (!quote || byId.has(quote.id)) continue;
    byId.set(quote.id, quote);
  }
  return { quotes: [...byId.values()], partial };
}

function parseIndices(text: string): IndexQuote[] {
  const rows: IndexQuote[] = [];
  for (const line of text.split("\n")) {
    const idMatch = line.match(/^v_([a-z]{2}\d+)/);
    const body = line.match(/="([^"]*)"/);
    if (!idMatch || !body) continue;
    const parts = body[1].split("~");
    if (parts.length < 33) continue;
    const price = Number(parts[3]);
    const prev = Number(parts[4]);
    const chg = Number(parts[31]);
    if (!Number.isFinite(price)) continue;
    const stamp = parts[30] ?? "";
    const pct = prev ? (chg / prev) * 100 : Number(parts[32]);
    rows.push({
      id: idMatch[1],
      name: parts[1] || idMatch[1],
      price,
      chg: Number.isFinite(chg) ? chg : 0,
      pct: Number.isFinite(pct) ? pct : 0,
      time: stamp.length >= 12 ? `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}` : "",
    });
  }
  return rows;
}

/** 拉几只常用指数和沪深300ETF 的现价。ids 是 sh、sz 加六位代码。 */
export async function fetchTencentIndices(ids: readonly string[]): Promise<IndexQuote[]> {
  const url = `https://web.sqt.gtimg.cn/utf8/q=${ids.join(",")}`;
  const res = await fetch(url, {
    headers: { ...HEADERS, referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const rows = parseIndices(await res.text());
  if (rows.length === 0) throw new Error("index empty");
  return rows;
}
