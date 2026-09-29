export type FlowRow = {
  id: string;
  name: string;
  chg: number | null;
  /** 主力净流入，万元。 */
  inflow: number;
  leader: string;
};

export type FlowBook = {
  sectorsIn: FlowRow[];
  sectorsOut: FlowRow[];
  stocksIn: FlowRow[];
  stocksOut: FlowRow[];
  asOf: number;
};

type Raw = Record<string, unknown>;

const TTL_MS = 60_000;
let cache: { at: number; book: FlowBook } | null = null;

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function rank(url: string): Promise<Raw[]> {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://stockapp.finance.qq.com/" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: { rank_list?: Raw[] } };
  return Array.isArray(body.data?.rank_list) ? body.data.rank_list : [];
}

function rowOf(raw: Raw, kind: "sector" | "stock"): FlowRow | null {
  const id = String(raw.code ?? "");
  const name = String(raw.name ?? "").trim();
  const inflow = num(raw.zljlr);
  if (!id || !name || inflow == null) return null;
  if (kind === "stock" && (name.startsWith("N") || name.includes("ST") || name.includes("退"))) return null;
  const leader = raw.lzg && typeof raw.lzg === "object" ? String((raw.lzg as { name?: string }).name ?? "") : "";
  return { id, name, chg: num(raw.zdf), inflow, leader };
}

function take(list: Raw[], kind: "sector" | "stock", limit: number): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const raw of list) {
    const row = rowOf(raw, kind);
    if (!row) continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows;
}

/** 腾讯行业和个股的主力净流入。大约一分钟更新一次。 */
export async function loadFlow(): Promise<FlowBook> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.book;
  const sector = (direct: "down" | "up") =>
    `https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=netMainIn&direct=${direct}&offset=0&count=12`;
  const stock = (direct: "down" | "up") =>
    `https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=netMainIn&direct=${direct}&offset=0&count=20`;
  const [sectorsIn, sectorsOut, stocksIn, stocksOut] = await Promise.all([
    rank(sector("down")),
    rank(sector("up")),
    rank(stock("down")),
    rank(stock("up")),
  ]);
  const book: FlowBook = {
    sectorsIn: take(sectorsIn, "sector", 8),
    sectorsOut: take(sectorsOut, "sector", 8),
    stocksIn: take(stocksIn, "stock", 8),
    stocksOut: take(stocksOut, "stock", 8),
    asOf: Date.now(),
  };
  cache = { at: book.asOf, book };
  return book;
}
