import https from "node:https";

export type NewsBoard = {
  code: string;
  name: string;
};

export type NewsStock = {
  id: string;
  code: string;
  name: string;
  chg: number | null;
};

export type NewsTone = "good" | "bad" | "flat";

export type NewsItem = {
  id: string;
  time: string;
  title: string;
  summary: string;
  tone: NewsTone;
  boards: NewsBoard[];
  stocks: NewsStock[];
};

const TTL_MS = 60_000;
const GOOD = ["利好", "中标", "签约", "回购", "增持", "预增", "扭亏", "获批", "核准", "大涨", "涨停", "涨超", "上调", "订单", "创新高", "拉升", "走强", "放量"];
const BAD = ["利空", "减持", "预亏", "亏损", "下滑", "处罚", "立案", "退市", "跌停", "大跌", "跌超", "下调", "违规", "调查", "终止", "跳水", "下挫", "走弱", "问询"];
let cache: { at: number; rows: NewsItem[] } | null = null;
const boardNames = new Map<string, string>();

function getText(url: string, referer = "https://kuaixun.eastmoney.com/"): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "Mozilla/5.0", referer }, timeout: 12_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("消息超时")));
    req.on("error", reject);
  });
}

function stockId(token: string): string | null {
  const [market, code] = token.split(".");
  if (!/^\d{6}$/.test(code ?? "")) return null;
  if (market === "1") return `sh${code}`;
  if (market === "0") {
    if (code.startsWith("8") || code.startsWith("4") || code.startsWith("92")) return `bj${code}`;
    return `sz${code}`;
  }
  return null;
}

function boardCode(token: string): string | null {
  const [market, code] = token.split(".");
  if (market === "90" && /^BK\d{4}$/.test(code ?? "")) return code;
  return null;
}

function toneOf(text: string): NewsTone {
  const good = GOOD.filter((word) => text.includes(word)).length;
  const bad = BAD.filter((word) => text.includes(word)).length;
  if (good > bad) return "good";
  if (bad > good) return "bad";
  return "flat";
}

async function boardName(code: string): Promise<string> {
  const saved = boardNames.get(code);
  if (saved) return saved;
  try {
    const raw = await getText(`https://search-codetable.eastmoney.com/codetable/search?keyword=${code}&count=5`);
    const parsed = JSON.parse(raw) as { result?: { code?: string; shortName?: string }[] };
    const name = parsed.result?.find((row) => row.code === code)?.shortName?.trim() || code;
    boardNames.set(code, name);
    return name;
  } catch {
    return code;
  }
}

async function namesOf(ids: string[]): Promise<Map<string, { name: string; chg: number | null }>> {
  const out = new Map<string, { name: string; chg: number | null }>();
  if (ids.length === 0) return out;
  const text = await getText(`https://web.sqt.gtimg.cn/utf8/q=${ids.join(",")}`);
  for (const line of text.split(";")) {
    const match = line.match(/_([a-z]{2}\d{6})="(.*)"/);
    if (!match) continue;
    const parts = match[2].split("~");
    const name = parts[1]?.trim();
    const chg = Number(parts[32]);
    if (name) out.set(match[1], { name, chg: Number.isFinite(chg) ? chg : null });
  }
  return out;
}

/** 东方财富 7x24。板块和个股分开，用词分成利好、利空或没说清。 */
export async function loadNews(): Promise<NewsItem[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const raw = await getText(
    "https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=40&req_trace=1",
  );
  const parsed = JSON.parse(raw) as {
    data?: { fastNewsList?: { code?: string; showTime?: string; title?: string; summary?: string; stockList?: string[] }[] };
  };
  const list = parsed.data?.fastNewsList ?? [];
  const ids = new Set<string>();
  const boards = new Set<string>();
  const drafts = list.map((item) => {
    const stockIds = [...new Set((item.stockList ?? []).map(stockId).filter((id): id is string => id != null))];
    const boardCodes = [...new Set((item.stockList ?? []).map(boardCode).filter((code): code is string => code != null))];
    for (const id of stockIds) ids.add(id);
    for (const code of boardCodes) boards.add(code);
    const title = (item.title ?? "").trim();
    const summary = (item.summary ?? "").trim();
    return {
      id: String(item.code ?? item.showTime ?? title),
      time: item.showTime ?? "",
      title,
      summary,
      tone: toneOf(`${title} ${summary}`),
      stockIds,
      boardCodes,
    };
  });
  const [names, boardLabels] = await Promise.all([
    namesOf([...ids]).catch(() => new Map<string, { name: string; chg: number | null }>()),
    Promise.all([...boards].map(async (code) => [code, await boardName(code)] as const)),
  ]);
  const boardByCode = new Map(boardLabels);
  const rows = drafts
    .filter((item) => item.title || item.summary)
    .map((item) => ({
      id: item.id,
      time: item.time,
      title: item.title || item.summary.slice(0, 40),
      summary: item.summary,
      tone: item.tone,
      boards: item.boardCodes.map((code) => ({ code, name: boardByCode.get(code) || code })),
      stocks: item.stockIds.map((id) => {
        const live = names.get(id);
        return { id, code: id.slice(2), name: live?.name || id.slice(2), chg: live?.chg ?? null };
      }),
    }));
  cache = { at: Date.now(), rows };
  return rows;
}

export type StockHit = {
  id: string;
  code: string;
  name: string;
  board: string;
};

export type StockArticle = {
  id: string;
  time: string;
  title: string;
  tone: NewsTone;
  url: string;
};

const QUOTE_REFERER = "https://quote.eastmoney.com/";
const stockCache = new Map<string, { at: number; rows: StockArticle[] }>();

function emMarketCode(id: string): string | null {
  const match = id.match(/^(sh|sz|bj)(\d{6})$/);
  if (!match) return null;
  return `${match[1] === "sh" ? "1" : "0"}.${match[2]}`;
}

/** 按代码或名称找 A 股。 */
export async function searchStocks(keyword: string): Promise<StockHit[]> {
  const q = keyword.trim().slice(0, 20);
  if (!q) return [];
  const raw = await getText(
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&count=8`,
    QUOTE_REFERER,
  );
  const parsed = JSON.parse(raw) as {
    QuotationCodeTable?: { Data?: { Code?: string; Name?: string; QuoteID?: string; SecurityTypeName?: string; Classify?: string }[] };
  };
  const rows: StockHit[] = [];
  for (const row of parsed.QuotationCodeTable?.Data ?? []) {
    if (row.Classify && row.Classify !== "AStock") continue;
    const code = row.Code ?? "";
    const quoteId = row.QuoteID ?? "";
    if (!/^\d{6}$/.test(code) || !/^[01]\.\d{6}$/.test(quoteId)) continue;
    const market = quoteId.startsWith("1.") ? "sh" : code.startsWith("8") || code.startsWith("4") || code.startsWith("92") ? "bj" : "sz";
    rows.push({ id: `${market}${code}`, code, name: (row.Name ?? code).trim(), board: row.SecurityTypeName ?? "" });
  }
  return rows;
}

/** 一只股票最近的资讯。只有标题，用词分成利好、利空或没说清。 */
export async function loadStockArticles(id: string): Promise<StockArticle[]> {
  const hit = stockCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const code = emMarketCode(id);
  if (!code) return [];
  const raw = await getText(
    `https://np-listapi.eastmoney.com/comm/web/getListInfo?client=web&biz=web_news&mTypeAndCode=${code}&page_index=1&page_size=20&type=1&req_trace=1`,
    QUOTE_REFERER,
  );
  const parsed = JSON.parse(raw) as {
    data?: { list?: { Art_Code?: string; Art_ShowTime?: string; Art_Title?: string; Art_OriginUrl?: string }[] };
  };
  const rows = (parsed.data?.list ?? []).flatMap((item) => {
    const title = (item.Art_Title ?? "").trim();
    if (!title) return [];
    const url = item.Art_OriginUrl ?? "";
    return [
      {
        id: String(item.Art_Code ?? title),
        time: item.Art_ShowTime ?? "",
        title,
        tone: toneOf(title),
        url: url.startsWith("http://") || url.startsWith("https://") ? url : "",
      },
    ];
  });
  stockCache.set(id, { at: Date.now(), rows });
  return rows;
}
