/**
 * 这个文件是干什么的：
 * 五套选股策略。每套自己算买入价、卖出价、止损价，互不混用。
 *
 * 你需要知道的：
 * 每套最多同时拿 10 只。现价打到买入价才算买进，打到卖出价或止损价才算卖出。
 * 涨停不算能买进。买入当天不能卖（T+1），卖出日的判断在 journal-book.ts。
 * 「次日补涨」不在这里算价，它有自己的尾盘逻辑，所以 quoteOrder 对它直接返回空。
 */
import { limitPct, limitTag, planExit, screen, type Scored } from "./model.ts";
import type { EarlyRules } from "./rules.ts";
import type { Quote } from "./types.ts";

/** 五套策略的内部编号。页面上的中文名在 STYLES 里。 */
export type StyleId = "early" | "trend" | "breakout" | "value" | "relay";

/**
 * 一只股票在某一套策略下的计划价。
 * buy 买入价，sell 卖出价，stop 止损价，单位都是元。
 * hit 为 true 表示现价已经碰到买入条件，还要再检查没涨停、名额还够，才会记入持仓。
 */
export type Order = Scored & {
  buy: number;
  sell: number;
  stop: number;
  hit: boolean;
};

/** 页面上的五套标签。hint 是给用户看的一句人话，真正的门槛在下面各个函数里。 */
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
  {
    id: "relay",
    name: "次日补涨",
    hint: "收盘前半小时，在当天最强的三个概念板块里，买还能成交的次强，不买龙头和涨停。下一交易日卖。",
  },
];

/** 把价格四舍五入到分。A 股报价最小是 0.01 元。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 用现价和涨跌幅倒推昨收。涨跌幅是百分比，例如 10 表示涨了 10%。 */
function prevClose(quote: Quote): number | null {
  if (quote.chg == null || !(quote.price > 0)) return null;
  const denom = 1 + quote.chg / 100;
  if (!(denom > 0)) return null;
  return quote.price / denom;
}

/**
 * 这只票现在能不能拿来做计划。
 * 不要：ST、股价低于 4 元、总市值低于 40 亿、已经贴着涨停或跌停（那种价往往买不进或卖不出）。
 */
function tradable(quote: Quote): boolean {
  if (quote.st || quote.price < 4 || quote.cap < 40 || quote.chg == null) return false;
  const limit = limitPct(quote);
  if (quote.chg >= limit - 0.3 || quote.chg <= -limit + 0.3) return false;
  return true;
}

/**
 * 启动前期。门槛在 rules.ts，这里只把「允许涨幅的中间」换成买入价。
 * 现价回到买入价和止损价之间才算 hit，也就是等它回落，不追高。
 */
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

/**
 * 趋势回踩。20 日涨了 10% 到 40%，60 日至少涨了 5%，今天在 0 到跌 4% 之间。
 * 买入价就是昨收。止损按 20 日涨幅的四分之一，至少 3%。
 */
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

/**
 * 放量突破。量比至少 1.8，换手至少 2%，成交额至少 8000 万元。
 * 买入价是昨收再往上 2%。现价刚过这个价、还没再冲过 1.5% 才买。止损放在昨收。
 */
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

/**
 * 低估值。市盈率不超过 18 倍，市净率不超过 2 倍，总市值至少 100 亿。
 * 买入价按市盈率 15 倍折算，卖出价按 22 倍折算，止损按 10 倍折算。
 */
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

/** 五套策略的固定顺序。页面上的标签就按这个排。 */
export const STYLE_IDS: StyleId[] = ["early", "trend", "breakout", "value", "relay"];
/** 每一套每天最多新进这么多只。 */
export const MAX_POSITIONS = 10;

/** 一笔成交属于哪一套。旧账上没有这五套之一的名字时返回空，不塞进任何一套。 */
export function styleOf(trade: { style?: string }): StyleId | null {
  if (trade.style === "early" || trade.style === "trend" || trade.style === "breakout" || trade.style === "value" || trade.style === "relay") return trade.style;
  return null;
}

/**
 * 这套策略「这一天」还剩几个名额。
 * 名额按天算：看的是当天已经记进了几只，不受前几天还没卖出的影响。
 * 昨天那批占的是昨天的名额，今天照样能进新的。
 * 当天已经卖出的也算占过名额，不会退回——它进过这一天的池子。
 */
export function daySlotsLeft(dayTrades: { style?: string }[], style: StyleId): number {
  const taken = dayTrades.filter((trade) => styleOf(trade) === style).length;
  return Math.max(0, MAX_POSITIONS - taken);
}

/** 观察名单上的一行。block 有值时今天不能按这个价买：limit 是涨停买不进，away 是价格已经离开买入价。 */
export type Listed = {
  quote: Quote;
  score: number;
  reasons: string[];
  buy: number;
  sell: number;
  stop: number;
  hit: boolean;
  /** 冻结之后不能买的原因。没有就是还能按买入价成交。 */
  block?: "limit" | "away";
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

/**
 * 从观察名单里挑出现在该记入的买单。
 * 条件：现价已经 hit、不是涨停、这套里已经持有的不再重复买、当天的名额还够。
 * dayTrades 是「这一天」已经记下的成交，用来算当天还剩几个名额；
 * held 是所有还没卖出的成交，用来排重——同一只已经在手上就只在最早那笔，不再开第二笔。
 */
export function takeBuys(
  list: Listed[],
  held: { id: string; style?: string; exit: number | null }[],
  style: StyleId,
  dayTrades: { style?: string }[],
): Listed[] {
  const openIds = new Set(held.filter((trade) => trade.exit == null && styleOf(trade) === style).map((trade) => trade.id));
  // 名单自己也可能把同一只股票列两次（接力按概念板块提名，一只票可能同属几个板块），
  // 只认第一次出现的那行，以最先的为准。
  const seen = new Set<string>();
  return list
    .filter((row) => row.hit && limitTag(row.quote) !== "涨停" && !openIds.has(row.quote.id))
    .filter((row) => (seen.has(row.quote.id) ? false : (seen.add(row.quote.id), true)))
    .slice(0, daySlotsLeft(dayTrades, style));
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

/**
 * 给一只行情算出这一套的计划价。
 * 次日补涨不走这里。对不上趋势、突破、低估值时，按启动前期算。
 */
export function quoteOrder(style: StyleId, quote: Quote, rules: EarlyRules): Order | null {
  if (style === "relay") return null;
  if (style === "trend") return trendOrder(quote);
  if (style === "breakout") return breakoutOrder(quote);
  if (style === "value") return valueOrder(quote);
  return earlyOrder(quote, rules);
}
