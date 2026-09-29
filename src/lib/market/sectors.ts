import https from "node:https";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { limitPct } from "./model.ts";
import type { Listed } from "./strategies.ts";
import type { Board, Quote } from "./types.ts";

type Member = {
  symbol: string;
  name: string;
  price: number;
  chg: number;
  amount: number;
  cap: number;
};

const cache = { at: 0, tailHalf: false, rows: [] as Listed[] };
const freezePath = join(process.cwd(), "data", "relay-freeze.json");

function boardOf(id: string): Board {
  if (id.startsWith("sh688") || id.startsWith("sh689")) return "kcb";
  if (id.startsWith("sz300") || id.startsWith("sz301")) return "cyb";
  if (id.startsWith("bj")) return "bj";
  if (id.startsWith("sh")) return "sh";
  return "sz";
}

function asQuote(member: Member): Quote {
  return {
    id: member.symbol,
    code: member.symbol.slice(2),
    name: member.name,
    board: boardOf(member.symbol),
    price: member.price,
    chg: member.chg,
    pe: null,
    pb: null,
    cap: member.cap,
    floatCap: 0,
    turnover: 0,
    volRatio: 0,
    amp: 0,
    d5: null,
    d10: null,
    d20: null,
    d60: null,
    ytd: null,
    inflow: 0,
    amount: member.amount / 10000,
    st: member.name.toUpperCase().includes("ST") || member.name.includes("退"),
  };
}

function getBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn/" } },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          res.resume();
          reject(new Error("板块暂时拉不下来"));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error("板块暂时拉不下来")));
    req.on("error", reject);
  });
}

async function readGbk(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return new TextDecoder("gbk").decode(await getBuffer(url));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("板块暂时拉不下来");
}

async function conceptBoards(): Promise<{ id: string; name: string; pct: number }[]> {
  const text = await readGbk("https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class");
  const rows: { id: string; name: string; pct: number }[] = [];
  for (const match of text.matchAll(/"([^"]+)"/g)) {
    const parts = match[1].split(",");
    if (!parts[0]?.startsWith("gn_") || parts.length < 6) continue;
    const pct = Number(parts[5]);
    if (!Number.isFinite(pct)) continue;
    rows.push({ id: parts[0], name: parts[1] || parts[0], pct });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

async function membersOf(node: string): Promise<Member[]> {
  const url =
    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
    `?page=1&num=40&sort=changepercent&asc=0&node=${encodeURIComponent(node)}`;
  let body: {
    symbol?: string;
    name?: string;
    trade?: string;
    changepercent?: string;
    amount?: number;
    mktcap?: number;
  }[];
  try {
    body = JSON.parse((await getBuffer(url)).toString("utf8")) as typeof body;
  } catch {
    return [];
  }
  if (!Array.isArray(body)) return [];
  const rows: Member[] = [];
  for (const item of body) {
    const symbol = item.symbol ?? "";
    const price = Number(item.trade);
    const chg = Number(item.changepercent);
    if (!/^(sh|sz|bj)\d{6}$/.test(symbol) || !(price > 0) || !Number.isFinite(chg)) continue;
    rows.push({
      symbol,
      name: item.name ?? symbol,
      price,
      chg,
      amount: Number(item.amount) || 0,
      cap: (Number(item.mktcap) || 0) / 10000,
    });
  }
  return rows.sort((a, b) => b.chg - a.chg);
}

function secondStrong(members: Member[], sector: string, sectorPct: number, tailHalf: boolean): Listed | null {
  const ranked = members.filter((item) => !asQuote(item).st && item.amount >= 50_000_000);
  if (ranked.length < 2) return null;
  const leader = ranked[0];
  for (const item of ranked.slice(1)) {
    const quote = asQuote(item);
    const limit = limitPct(quote);
    const gap = leader.chg - item.chg;
    if (item.chg < 2 || item.chg >= limit - 1 || gap < 2) continue;
    const buy = Math.round(item.price * 100) / 100;
    const targetPct = Math.min(6, gap);
    const sell = Math.round(buy * (1 + targetPct / 100) * 100) / 100;
    const stop = Math.round(buy * (1 - 0.03) * 100) / 100;
    if (!(stop < buy && buy < sell)) continue;
    return {
      quote,
      score: Math.round(sectorPct * 10 + gap),
      reasons: [
        `${sector} +${sectorPct.toFixed(1)}%`,
        `龙头 ${leader.name} +${leader.chg.toFixed(1)}%，这只次强 +${item.chg.toFixed(1)}%`,
        "尾盘买入，下一交易日卖",
      ],
      buy,
      sell,
      stop,
      hit: tailHalf && quote.price > 0 && item.chg < limit - 1,
    };
  }
  return null;
}

/** 当天涨幅最高的三个概念板块，各取一只还能买的次强。14:30 冻结，之后不换人。 */
export async function loadRelay(tailHalf: boolean, date: string): Promise<Listed[]> {
  const frozen = await readFreeze(date);
  if (frozen) return refreshFrozen(frozen);
  if (cache.rows.length > 0 && cache.tailHalf === tailHalf && Date.now() - cache.at < 60_000) return cache.rows;
  const picks = await rankRelay(tailHalf);
  cache.at = Date.now();
  cache.tailHalf = tailHalf;
  cache.rows = picks;
  if (!tailHalf) return picks;
  await writeFreeze(date, picks);
  return picks;
}

async function rankRelay(tailHalf: boolean): Promise<Listed[]> {
  const boards = (await conceptBoards()).filter((item) => item.pct >= 1.5).slice(0, 3);
  const picks: Listed[] = [];
  for (const board of boards) {
    const members = await membersOf(board.id);
    const pick = secondStrong(members, board.name, board.pct, tailHalf);
    if (pick) picks.push(pick);
  }
  picks.sort((a, b) => b.score - a.score);
  return picks;
}

async function readFreeze(date: string): Promise<Listed[] | null> {
  try {
    const raw = JSON.parse(await readFile(freezePath, "utf8")) as { date?: string; picks?: Listed[] };
    if (raw.date !== date || !Array.isArray(raw.picks)) return null;
    return raw.picks;
  } catch {
    return null;
  }
}

async function writeFreeze(date: string, picks: Listed[]): Promise<void> {
  const existing = await readFreeze(date);
  if (existing) return;
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(freezePath, JSON.stringify({ date, picks }, null, 2));
}

async function livePrices(ids: string[]): Promise<Map<string, { price: number; chg: number }>> {
  const out = new Map<string, { price: number; chg: number }>();
  if (ids.length === 0) return out;
  const text = (await getBuffer(`https://web.sqt.gtimg.cn/utf8/q=${ids.join(",")}`)).toString("utf8");
  for (const line of text.split(";")) {
    const match = line.match(/_([a-z]{2}\d{6})="(.*)"/);
    if (!match) continue;
    const parts = match[2].split("~");
    const price = Number(parts[3]);
    const prev = Number(parts[4]);
    const chg = Number(parts[32]);
    const pct = Number.isFinite(chg) ? chg : prev > 0 && price > 0 ? ((price - prev) / prev) * 100 : NaN;
    if (price > 0 && Number.isFinite(pct)) out.set(match[1], { price, chg: pct });
  }
  return out;
}

async function refreshFrozen(picks: Listed[]): Promise<Listed[]> {
  let live = new Map<string, { price: number; chg: number }>();
  try {
    live = await livePrices(picks.map((pick) => pick.quote.id));
  } catch {
    live = new Map();
  }
  return picks.map((pick) => {
    const now = live.get(pick.quote.id);
    const quote = now ? { ...pick.quote, price: now.price, chg: now.chg } : pick.quote;
    const limit = limitPct(quote);
    const chg = quote.chg ?? 0;
    const base = pick.reasons.filter((line) => !line.startsWith("14:30"));
    if (!now) {
      return { ...pick, quote, hit: false, block: "away" as const, reasons: [...base, "14:30 已冻结。现价没刷新，先不买"] };
    }
    if (chg >= limit - 1) {
      return { ...pick, quote, hit: false, block: "limit" as const, reasons: [...base, "14:30 已冻结。现在涨停，买不进"] };
    }
    if (quote.price > pick.buy + 0.01) {
      return { ...pick, quote, hit: false, block: "away" as const, reasons: [...base, "14:30 已冻结。现价高过买入价，不追"] };
    }
    return { ...pick, quote, hit: true, block: undefined, reasons: [...base, "14:30 已冻结。现价还在买入价上"] };
  });
}

export function relayHold(): number {
  return 1;
}
