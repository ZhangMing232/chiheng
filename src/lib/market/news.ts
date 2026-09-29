import https from "node:https";

export type NewsStock = {
  id: string;
  code: string;
  name: string;
  chg: number | null;
};

export type NewsItem = {
  id: string;
  time: string;
  title: string;
  summary: string;
  stocks: NewsStock[];
};

const TTL_MS = 60_000;
let cache: { at: number; rows: NewsItem[] } | null = null;

function getText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "Mozilla/5.0", referer: "https://kuaixun.eastmoney.com/" }, timeout: 12_000 },
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

/** 东方财富 7x24。板块代码丢掉，只留个股。 */
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
  const drafts = list.map((item) => {
    const stocks = [...new Set((item.stockList ?? []).map(stockId).filter((id): id is string => id != null))];
    for (const id of stocks) ids.add(id);
    return {
      id: String(item.code ?? item.showTime ?? item.title ?? ""),
      time: item.showTime ?? "",
      title: (item.title ?? "").trim(),
      summary: (item.summary ?? "").trim(),
      stockIds: stocks,
    };
  });
  const names = await namesOf([...ids]).catch(() => new Map<string, { name: string; chg: number | null }>());
  const rows = drafts
    .filter((item) => item.title || item.summary)
    .map((item) => ({
      id: item.id,
      time: item.time,
      title: item.title || item.summary.slice(0, 40),
      summary: item.summary,
      stocks: item.stockIds.map((id) => {
        const live = names.get(id);
        return { id, code: id.slice(2), name: live?.name || id.slice(2), chg: live?.chg ?? null };
      }),
    }));
  cache = { at: Date.now(), rows };
  return rows;
}
