import { shanghaiDate } from "./session.ts";

export type FutMember = { name: string; lots: number; chg: number };

export type FutBook = {
  date: string;
  rows: {
    name: string;
    contract: string;
    longLots: number;
    shortLots: number;
    longTop: FutMember[];
    shortTop: FutMember[];
  }[];
};

const PRODUCTS = [
  { code: "IF", name: "沪深300" },
  { code: "IH", name: "上证50" },
  { code: "IC", name: "中证500" },
  { code: "IM", name: "中证1000" },
];

const TTL_MS = 5 * 60_000;
let cache: { at: number; book: FutBook } | null = null;

function ymd(date: string): string {
  return date.replaceAll("-", "");
}

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function csv(product: string, date: string): Promise<string | null> {
  const stamp = ymd(date);
  const url = `http://www.cffex.com.cn/sj/ccpm/${stamp.slice(0, 6)}/${stamp.slice(6)}/${product}_1.csv`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("gbk").decode(buf);
  return text.includes(stamp) ? text : null;
}

function members(text: string, contract: string, side: "long" | "short"): FutMember[] {
  const nameAt = side === "long" ? 6 : 9;
  const lotsAt = side === "long" ? 7 : 10;
  const chgAt = side === "long" ? 8 : 11;
  const rows: FutMember[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cell = line.split(",");
    if (cell[1] !== contract || !/^\d+$/.test(cell[2] ?? "")) continue;
    const lots = Number(cell[lotsAt]);
    const chg = Number(cell[chgAt]);
    const name = (cell[nameAt] ?? "").replace("(代客)", "").trim();
    if (!name || !Number.isFinite(lots)) continue;
    rows.push({ name, lots, chg: Number.isFinite(chg) ? chg : 0 });
  }
  return rows.sort((a, b) => b.lots - a.lots);
}

function mainContract(text: string): string {
  const score = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const cell = line.split(",");
    if (!/^\d+$/.test(cell[2] ?? "")) continue;
    const contract = cell[1] ?? "";
    const longLots = Number(cell[7]);
    const shortLots = Number(cell[10]);
    score.set(contract, (score.get(contract) ?? 0) + (Number.isFinite(longLots) ? longLots : 0) + (Number.isFinite(shortLots) ? shortLots : 0));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** 中金所公布的股指期货会员多空单。文件写明是代客，不是单独的机构账户。 */
export async function loadIndexFutures(): Promise<FutBook> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.book;
  let date = shanghaiDate();
  let found = "";
  for (let i = 0; i < 6 && !found; i += 1) {
    const text = await csv("IF", date);
    if (text) found = date;
    else date = shift(date, -1);
  }
  if (!found) return { date: "", rows: [] };
  const rows = [];
  for (const product of PRODUCTS) {
    const text = product.code === "IF" ? await csv("IF", found) : await csv(product.code, found);
    if (!text) continue;
    const contract = mainContract(text);
    if (!contract) continue;
    const longTop = members(text, contract, "long");
    const shortTop = members(text, contract, "short");
    rows.push({
      name: product.name,
      contract,
      longLots: longTop.reduce((sum, row) => sum + row.lots, 0),
      shortLots: shortTop.reduce((sum, row) => sum + row.lots, 0),
      longTop: longTop.slice(0, 3),
      shortTop: shortTop.slice(0, 3),
    });
  }
  const book = { date: found, rows };
  cache = { at: Date.now(), book };
  return book;
}
