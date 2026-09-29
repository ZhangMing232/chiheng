export type FlowRow = {
  id: string;
  name: string;
  chg: number | null;
  /** 主力净流入，万元。 */
  inflow: number;
  leader: string;
};

export type NorthLeg = {
  name: string;
  date: string;
  /** 成交额，万元。净流入没有公布。 */
  amount: number;
  leader: string;
};

export type MarketPart = {
  name: string;
  /** 万元。主力 = 超大单 + 大单。 */
  main: number;
  super: number;
  big: number;
  mid: number;
  small: number;
  /** 万元。散户是这笔统计里主力以外的成交，和主力大致互为相反数。 */
  retail: number;
};

/** 主力与散户是同一笔成交的两边。真正的差别在单子大小和沪深是否同向。 */
export function readMarket(parts: MarketPart[]): string[] {
  if (parts.length === 0) return [];
  const sum = (key: keyof Omit<MarketPart, "name">) => parts.reduce((total, part) => total + part[key], 0);
  const lines = ["主力净额和散户净额是同一笔成交的两边，不是两群人。散户净流入大约等于主力净流出。"];
  const superNet = sum("super");
  const big = sum("big");
  if (superNet * big < 0) {
    lines.push(
      superNet > 0
        ? "主力内部不一致：超大单在进，大单在出。只看主力净额会把这个差别抹平。"
        : "主力内部不一致：超大单在出，大单在进。只看主力净额会把这个差别抹平。",
    );
  } else {
    lines.push("超大单和大单同向，主力内部没有对着做。");
  }
  const mid = sum("mid");
  const small = sum("small");
  if (mid * small < 0) {
    lines.push(small > 0 ? "散户这边也不齐：小单在进，中单在出。" : "散户这边也不齐：小单在出，中单在进。");
  }
  const sh = parts.find((part) => part.name === "沪市");
  const sz = parts.find((part) => part.name === "深市");
  if (sh && sz && sh.main * sz.main < 0) {
    lines.push(sh.main > 0 ? "沪市主力在进，深市主力在出。不要合成一个方向。" : "沪市主力在出，深市主力在进。不要合成一个方向。");
  } else if (sh && sz && (sh.main !== 0 || sz.main !== 0)) {
    lines.push(Math.abs(sh.main) >= Math.abs(sz.main) ? "两市主力同向，幅度主要在沪市。" : "两市主力同向，幅度主要在深市。");
  }
  return lines;
}

export type FlowBook = {
  sectorsIn: FlowRow[];
  sectorsOut: FlowRow[];
  stocksIn: FlowRow[];
  stocksOut: FlowRow[];
  north: NorthLeg[];
  market: MarketPart[];
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

async function loadNorth(): Promise<NorthLeg[]> {
  const legs: { type: string; name: string }[] = [
    { type: "001", name: "沪股通" },
    { type: "003", name: "深股通" },
  ];
  const rows = await Promise.all(
    legs.map(async (leg) => {
      const url =
        "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY" +
        "&columns=TRADE_DATE,DEAL_AMT,LEAD_STOCKS_NAME" +
        `&filter=(MUTUAL_TYPE=%22${leg.type}%22)&pageNumber=1&pageSize=1&sortColumns=TRADE_DATE&sortTypes=-1`;
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { data?: { TRADE_DATE?: string; DEAL_AMT?: number; LEAD_STOCKS_NAME?: string }[] } };
      const row = body.result?.data?.[0];
      const amount = num(row?.DEAL_AMT);
      if (!row || amount == null) return null;
      return {
        name: leg.name,
        date: String(row.TRADE_DATE ?? "").slice(0, 10),
        amount: amount * 100,
        leader: String(row.LEAD_STOCKS_NAME ?? ""),
      };
    }),
  );
  return rows.filter((row): row is NorthLeg => row != null);
}

function wanYuan(value: unknown): number {
  const n = num(value);
  return n == null ? 0 : n / 10_000;
}

async function marketPart(code: string, name: string): Promise<MarketPart | null> {
  const res = await fetch(
    `https://proxy.finance.qq.com/cgi/cgi-bin/fundflow/hsfundtab?code=${code}&type=todayFundFlow&klineNeedDay=1`,
    {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" },
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: { todayFundFlow?: Record<string, unknown> } };
  const row = body.data?.todayFundFlow;
  if (!row) return null;
  return {
    name,
    main: wanYuan(row.mainNetIn),
    super: wanYuan(row.superFlow),
    big: wanYuan(row.bigFlow),
    mid: wanYuan(row.normalFlow),
    small: wanYuan(row.smallFlow),
    retail: wanYuan(num(row.retailIn) != null && num(row.retailOut) != null ? Number(row.retailIn) - Number(row.retailOut) : null),
  };
}

async function loadMarket(): Promise<MarketPart[]> {
  const rows = await Promise.all([marketPart("sh000001", "沪市"), marketPart("sz399001", "深市")]);
  return rows.filter((row): row is MarketPart => row != null);
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
  const [north, market] = await Promise.all([loadNorth().catch(() => [] as NorthLeg[]), loadMarket().catch(() => [] as MarketPart[])]);
  const book: FlowBook = {
    sectorsIn: take(sectorsIn, "sector", 8),
    sectorsOut: take(sectorsOut, "sector", 8),
    stocksIn: take(stocksIn, "stock", 8),
    stocksOut: take(stocksOut, "stock", 8),
    north,
    market,
    asOf: Date.now(),
  };
  cache = { at: book.asOf, book };
  return book;
}
