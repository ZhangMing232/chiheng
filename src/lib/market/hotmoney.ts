export type HotStock = { name: string; netWan: number };

export type HotSeat = {
  name: string;
  netWan: number;
  stocks: HotStock[];
};

export type HotBook = {
  date: string;
  buys: HotSeat[];
  sells: HotSeat[];
};

type Raw = Record<string, unknown>;

const TTL_MS = 5 * 60_000;
let cache: { at: number; book: HotBook } | null = null;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function shortSeat(name: string): string {
  return name
    .replace(/股份有限公司/g, "")
    .replace(/有限责任公司/g, "")
    .replace(/证券营业部/g, "")
    .replace(/证券分公司/g, "分公司")
    .trim();
}

function skipSeat(name: string): boolean {
  return name.includes("机构") || name.includes("沪股通") || name.includes("深股通");
}

async function pull(report: string, date: string): Promise<Raw[]> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=SECURITY_CODE,OPERATEDEPT_NAME,NET" +
    `&pageSize=500&pageNumber=1&reportName=${report}&filter=${filter}&sortColumns=NET&sortTypes=-1&source=WEB&client=WEB`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/stock/lhb.html" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  return Array.isArray(body.result?.data) ? body.result.data : [];
}

async function namesOf(date: string): Promise<Map<string, string>> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=SECURITY_CODE,SECURITY_NAME_ABBR" +
    `&pageSize=500&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&filter=${filter}&source=WEB&client=WEB`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(12_000),
  });
  const map = new Map<string, string>();
  if (!res.ok) return map;
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  for (const row of body.result?.data ?? []) {
    const code = String(row.SECURITY_CODE ?? "");
    const name = String(row.SECURITY_NAME_ABBR ?? "").trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

async function latestDate(): Promise<string> {
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=TRADE_DATE&pageSize=1&pageNumber=1" +
    "&reportName=RPT_BILLBOARD_DAILYDETAILSBUY&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB";
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return "";
  const body = (await res.json()) as { result?: { data?: { TRADE_DATE?: string }[] } };
  return String(body.result?.data?.[0]?.TRADE_DATE ?? "").slice(0, 10);
}

/** 龙虎榜营业部的买卖股票。机构席位和北向不放进游资。金额是万元。收盘后才有。 */
export async function loadHotMoney(): Promise<HotBook> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.book;
  const date = await latestDate();
  if (!date) return { date: "", buys: [], sells: [] };
  const [buys, sells, names] = await Promise.all([
    pull("RPT_BILLBOARD_DAILYDETAILSBUY", date),
    pull("RPT_BILLBOARD_DAILYDETAILSSELL", date),
    namesOf(date),
  ]);
  const seats = new Map<string, { name: string; net: number; stocks: Map<string, number> }>();
  for (const row of [...buys, ...sells]) {
    const rawName = String(row.OPERATEDEPT_NAME ?? "").trim();
    if (!rawName || skipSeat(rawName)) continue;
    const code = String(row.SECURITY_CODE ?? "");
    const net = num(row.NET) / 10_000;
    if (!code || net === 0) continue;
    const seat = seats.get(rawName) ?? { name: shortSeat(rawName), net: 0, stocks: new Map() };
    seat.net += net;
    seat.stocks.set(code, (seat.stocks.get(code) ?? 0) + net);
    seats.set(rawName, seat);
  }
  const ranked = [...seats.values()].map((seat) => ({
    name: seat.name,
    netWan: seat.net,
    stocks: [...seat.stocks.entries()]
      .map(([code, netWan]) => ({ name: names.get(code) ?? code, netWan }))
      .sort((a, b) => Math.abs(b.netWan) - Math.abs(a.netWan))
      .slice(0, 4),
  }));
  const book: HotBook = {
    date,
    buys: ranked.filter((seat) => seat.netWan > 0).sort((a, b) => b.netWan - a.netWan).slice(0, 8),
    sells: ranked.filter((seat) => seat.netWan < 0).sort((a, b) => a.netWan - b.netWan).slice(0, 8),
  };
  cache = { at: Date.now(), book };
  return book;
}
