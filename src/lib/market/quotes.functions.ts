import { createServerFn } from "@tanstack/react-start";
import type { Bar, Board, IndexQuote, Quote, Universe } from "@/lib/market/types";

type Raw = Record<string, string | undefined>;

const TTL_MS = 60_000;
const INDEX_TTL_MS = 20_000;
const HEADERS = {
  "user-agent": "Mozilla/5.0",
  referer: "https://stockapp.finance.qq.com/",
  accept: "application/json,text/plain,*/*",
};

const INDEX_IDS = ["sh000300", "sh000001", "sz399001", "sz399006", "sh000688"] as const;

let universeCache: { at: number; payload: Universe } | null = null;
let universeInflight: Promise<Universe> | null = null;
let indexCache: { at: number; rows: IndexQuote[] } | null = null;
const klineCache = new Map<string, { at: number; bars: Bar[] }>();

function num(value: string | undefined, kind: "any" | "pct" | "ratio"): number | null {
  if (value == null || value === "" || value === "-") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (kind === "pct" && Math.abs(n) >= 400) return null;
  if (kind === "ratio" && Math.abs(n) >= 5000) return null;
  return n;
}

function boardOf(id: string, stockType: string): Board {
  const kind = stockType.toUpperCase();
  if (kind.includes("KCB") || id.startsWith("sh688") || id.startsWith("sh689")) return "kcb";
  if (kind.includes("CYB") || id.startsWith("sz300") || id.startsWith("sz301")) return "cyb";
  if (id.startsWith("bj") || kind.includes("BJ")) return "bj";
  if (id.startsWith("sh")) return "sh";
  return "sz";
}

function isSt(name: string): boolean {
  return name.toUpperCase().includes("ST") || name.includes("退");
}

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

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
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

async function fetchUniverse(): Promise<Universe> {
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
  return {
    quotes: [...byId.values()],
    asOf: Date.now(),
    total: byId.size,
    partial,
    stale: false,
  };
}

async function loadUniverse(refresh: boolean): Promise<Universe> {
  if (!refresh && universeCache && Date.now() - universeCache.at < TTL_MS) {
    return universeCache.payload;
  }
  if (!refresh && universeInflight) return universeInflight;
  const run = (async () => {
    try {
      const payload = await fetchUniverse();
      universeCache = { at: payload.asOf, payload };
      return payload;
    } catch {
      if (universeCache) return { ...universeCache.payload, stale: true };
      throw new Error("行情暂时拉不下来，请稍后再刷新");
    }
  })();
  universeInflight = run;
  try {
    return await run;
  } finally {
    universeInflight = null;
  }
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

async function loadIndices(): Promise<IndexQuote[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.rows;
  const url = `https://web.sqt.gtimg.cn/utf8/q=${INDEX_IDS.join(",")}`;
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, referer: "https://gu.qq.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("index");
    const rows = parseIndices(await res.text());
    if (rows.length === 0) throw new Error("index empty");
    indexCache = { at: Date.now(), rows };
    return rows;
  } catch {
    if (indexCache) return indexCache.rows;
    return [];
  }
}

async function loadKline(id: string): Promise<{ id: string; bars: Bar[] }> {
  const hit = klineCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return { id, bars: hit.bars };
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,120,qfq`;
  const res = await fetch(url, {
    headers: { ...HEADERS, referer: "https://gu.qq.com/" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("K 线暂时拉不下来");
  const body = (await res.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  const node = body.data?.[id];
  const rows = node?.qfqday ?? node?.day ?? [];
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const o = Number(row[1]);
    const c = Number(row[2]);
    const h = Number(row[3]);
    const l = Number(row[4]);
    const v = Number(row[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    bars.push({ date: row[0] ?? "", o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  klineCache.set(id, { at: Date.now(), bars });
  if (klineCache.size > 40) {
    const oldest = klineCache.keys().next().value;
    if (oldest) klineCache.delete(oldest);
  }
  return { id, bars };
}

function readRefresh(data: unknown): { refresh: boolean } {
  if (
    typeof data === "object" &&
    data !== null &&
    "refresh" in data &&
    (data as { refresh?: unknown }).refresh === true
  ) {
    return { refresh: true };
  }
  return { refresh: false };
}

export const getUniverse = createServerFn({ method: "GET" })
  .validator(readRefresh)
  .handler(async ({ data }) => loadUniverse(data.refresh));

export const getIndices = createServerFn({ method: "GET" }).handler(async () => loadIndices());

export const getKline = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      !("id" in data) ||
      typeof (data as { id?: unknown }).id !== "string"
    ) {
      throw new Error("无效的股票代码");
    }
    const id = (data as { id: string }).id;
    if (!/^(sh|sz|bj)\d{6}$/.test(id)) throw new Error("无效的股票代码");
    return { id };
  })
  .handler(async ({ data }) => loadKline(data.id));
