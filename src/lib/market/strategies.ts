import { limitPct, limitTag, planExit, screen, type Scored } from "./model.ts";
import type { EarlyRules } from "./rules.ts";
import type { Quote } from "./types.ts";

export type StyleId = "early" | "trend" | "breakout" | "value";

export type Order = Scored & {
  buy: number;
  sell: number;
  stop: number;
  hit: boolean;
};

export const STYLES: { id: StyleId; name: string; hint: string }[] = [
  {
    id: "early",
    name: "启动前期",
    hint: "刚转强、还没走远。买入价在当天允许涨幅的中部，现价回到这个价才买。",
  },
  {
    id: "trend",
    name: "趋势回踩",
    hint: "20 日和 60 日已经向上。买入价是昨收，等它回踩到昨收再买，不追当天的高点。",
  },
  {
    id: "breakout",
    name: "放量突破",
    hint: "量比和换手起来，突破昨收上面 2%。现价刚过买入价才买，已经冲远了不追。",
  },
  {
    id: "value",
    name: "低估值",
    hint: "市盈率不超过 18 倍、市净率不超过 2 倍。买入价按市盈率 15 倍折，卖出价按 22 倍折。",
  },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function prevClose(quote: Quote): number | null {
  if (quote.chg == null || !(quote.price > 0)) return null;
  const denom = 1 + quote.chg / 100;
  if (!(denom > 0)) return null;
  return quote.price / denom;
}

function tradable(quote: Quote): boolean {
  if (quote.st || quote.price < 4 || quote.cap < 40 || quote.chg == null) return false;
  const limit = limitPct(quote);
  if (quote.chg >= limit - 0.3 || quote.chg <= -limit + 0.3) return false;
  return true;
}

function earlyOrder(quote: Quote, rules: EarlyRules): Order | null {
  const scored = screen(quote, true, rules);
  const prev = prevClose(quote);
  if (!scored || prev == null) return null;
  const mid = (rules.chgMin + rules.chgMax) / 2;
  const buy = round2(prev * (1 + mid / 100));
  const plan = planExit(buy, quote.d20, rules);
  const stop = Math.min(plan.stop, round2(prev * (1 + rules.chgMin / 100)));
  if (!(stop < buy && buy < plan.target)) return null;
  return {
    ...scored,
    buy,
    sell: plan.target,
    stop,
    hit: quote.price <= buy && quote.price >= stop,
  };
}

function trendOrder(quote: Quote): Order | null {
  const prev = prevClose(quote);
  if (!tradable(quote) || prev == null || quote.d20 == null || quote.d60 == null) return null;
  if (quote.d20 < 10 || quote.d20 > 40 || quote.d60 < 5) return null;
  if (quote.chg == null || quote.chg > 1 || quote.chg < -4) return null;
  if (quote.amount < 5000 || quote.volRatio < 0.8) return null;
  const buy = round2(prev);
  const give = Math.max(3, quote.d20 * 0.25);
  const stop = round2(buy * (1 - give / 100));
  const sell = round2(buy * (1 + Math.max(40 - quote.d20, give) / 100));
  if (!(stop < buy && buy < sell)) return null;
  return {
    score: Math.round(quote.d20),
    reasons: [`20 日 +${quote.d20.toFixed(1)}%，趋势还在`, `60 日 +${quote.d60.toFixed(1)}%`, "回到昨收再买"],
    buy,
    sell,
    stop,
    hit: quote.price <= buy && quote.price >= stop,
  };
}

function breakoutOrder(quote: Quote): Order | null {
  const prev = prevClose(quote);
  if (!tradable(quote) || prev == null || quote.d5 == null || quote.d20 == null) return null;
  if (quote.volRatio < 1.8 || quote.turnover < 2 || quote.amount < 8000) return null;
  if (quote.d5 < 0 || quote.d5 > 8 || quote.d20 < 0 || quote.d20 > 20) return null;
  if (quote.chg == null || quote.chg < 0 || quote.chg > 7) return null;
  const buy = round2(prev * 1.02);
  const stop = round2(prev);
  const sell = round2(buy * (1 + Math.max(20 - quote.d20, 2) / 100));
  if (!(stop < buy && buy < sell)) return null;
  const ceiling = round2(buy * 1.015);
  return {
    score: Math.round(quote.volRatio * 10),
    reasons: [`量比 ${quote.volRatio.toFixed(2)}`, `5 日 +${quote.d5.toFixed(1)}%`, "过昨收 2% 才买"],
    buy,
    sell,
    stop,
    hit: quote.price >= buy && quote.price <= ceiling,
  };
}

function valueOrder(quote: Quote): Order | null {
  if (!tradable(quote) || quote.pe == null || quote.pb == null || quote.pe <= 0 || quote.pb <= 0) return null;
  if (quote.pe > 18 || quote.pb > 2 || quote.cap < 100) return null;
  if (quote.d60 != null && quote.d60 < -25) return null;
  if (quote.amount < 3000) return null;
  const buy = round2(quote.price * (Math.min(quote.pe, 15) / quote.pe));
  const entryPe = quote.pe * (buy / quote.price);
  const sell = round2(buy * (22 / entryPe));
  const stop = round2(buy * (10 / entryPe));
  if (!(stop < buy && buy < sell)) return null;
  return {
    score: Math.round(40 - quote.pe),
    reasons: [`市盈率 ${quote.pe.toFixed(1)} 倍`, `市净率 ${quote.pb.toFixed(2)} 倍`, "按 15 倍市盈率买，22 倍卖"],
    buy,
    sell,
    stop,
    hit: quote.price <= buy && quote.price >= stop,
  };
}

export const STYLE_IDS: StyleId[] = ["early", "trend", "breakout", "value"];
export const MAX_POSITIONS = 10;

export function styleOf(trade: { style?: string }): StyleId | null {
  if (trade.style === "early" || trade.style === "trend" || trade.style === "breakout" || trade.style === "value") return trade.style;
  return null;
}

export function slotsLeft(trades: { style?: string; exit: number | null }[], style: StyleId): number {
  const open = trades.filter((trade) => trade.exit == null && styleOf(trade) === style).length;
  return Math.max(0, MAX_POSITIONS - open);
}

export type Listed = {
  quote: Quote;
  score: number;
  reasons: string[];
  buy: number;
  sell: number;
  stop: number;
  hit: boolean;
};

/** 一套策略只看分数最高的 10 只。记账也只从这 10 只里打到买入价的来，不从全市场另买。 */
export function watchList(
  quotes: Quote[],
  style: StyleId,
  rules: EarlyRules,
  allow: (quote: Quote) => boolean,
): Listed[] {
  const rows: Listed[] = [];
  for (const quote of quotes) {
    if (!allow(quote)) continue;
    const order = quoteOrder(style, quote, rules);
    if (!order) continue;
    rows.push({
      quote,
      score: order.score,
      reasons: order.reasons,
      buy: order.buy,
      sell: order.sell,
      stop: order.stop,
      hit: order.hit,
    });
  }
  rows.sort((a, b) => b.score - a.score || b.quote.cap - a.quote.cap);
  return rows.slice(0, MAX_POSITIONS);
}

export function takeBuys(
  list: Listed[],
  held: { id: string; style?: string; exit: number | null }[],
  style: StyleId,
): Listed[] {
  const openIds = new Set(held.filter((trade) => trade.exit == null && styleOf(trade) === style).map((trade) => trade.id));
  return list.filter((row) => row.hit && limitTag(row.quote) !== "涨停" && !openIds.has(row.quote.id)).slice(0, slotsLeft(held, style));
}

/** 已持仓同时打到止损时，占这套 10 个名额的比例。空着的名额不算。 */
export function bookRisk(trades: { style?: string; exit: number | null; entry: number; stop?: number }[], style: StyleId): number | null {
  let sum = 0;
  let count = 0;
  for (const trade of trades) {
    if (trade.exit != null || styleOf(trade) !== style) continue;
    if (!(trade.entry > 0) || trade.stop == null || !(trade.stop > 0) || trade.stop >= trade.entry) continue;
    sum += (trade.entry - trade.stop) / trade.entry;
    count += 1;
  }
  if (count === 0) return null;
  return sum / MAX_POSITIONS;
}

export function quoteOrder(style: StyleId, quote: Quote, rules: EarlyRules): Order | null {
  if (style === "trend") return trendOrder(quote);
  if (style === "breakout") return breakoutOrder(quote);
  if (style === "value") return valueOrder(quote);
  return earlyOrder(quote, rules);
}
