import type { Board, Quote } from "@/lib/market/types";
import { DEFAULT_RULES, type EarlyRules } from "@/lib/market/rules";

export type StrategyId = "early" | "t1" | "blend" | "value" | "momentum" | "flow" | "rebound" | "active" | "custom";

export type Scored = { score: number; reasons: string[] };

export type Filters = {
  q: string;
  boards: Board[];
  excludeSt: boolean;
  peMin: string;
  peMax: string;
  pbMin: string;
  pbMax: string;
  capMin: string;
  capMax: string;
  chgMin: string;
  chgMax: string;
  d20Min: string;
  d20Max: string;
  d60Min: string;
  d60Max: string;
  hslMin: string;
  inflowMin: string;
};

export type SortKey =
  | "score"
  | "chg"
  | "pe"
  | "pb"
  | "cap"
  | "d20"
  | "d60"
  | "ytd"
  | "inflow"
  | "turnover"
  | "volRatio";

export const EARLY_HOLD = { min: 5, max: 10 };
export const TRACK_NEED = 60;

export const STRATEGIES: { id: StrategyId; name: string; hint: string; holdDays: number | null }[] = [
  {
    id: "early",
    name: "启动前期",
    holdDays: 8,
    hint: "规则可以改。默认今日涨 1% 到 4.5%，5 日 0 到 8%，20 日 -3% 到 12%，60 日 -10% 到 25%，量比 1.2 到 2.8，换手 1.5% 到 12%，成交额至少 5000 万，不碰涨跌停和 ST。改筛选条件后从下一笔记录重新计数。",
  },
  {
    id: "blend",
    name: "赤衡综合",
    holdDays: 40,
    hint: "盈利、市盈率不超过 40 倍、市净率不超过 5 倍、总市值 60 亿以上，且近 60 日没有深跌。预计持股 40 个交易日。天数跟着这套条件的观察窗口，不是测出来的最佳持有期。",
  },
  {
    id: "value",
    name: "价值底仓",
    holdDays: 60,
    hint: "市盈率 16 倍以内、市净率 1.8 倍以内、总市值 80 亿以上，避开近 60 日跌幅超过 35% 的标的。预计持股 60 个交易日。",
  },
  {
    id: "momentum",
    name: "趋势动量",
    holdDays: 20,
    hint: "20 日涨幅至少 10%、60 日至少 8%、近 5 日仍为正，且当天没有封死涨停。预计持股 20 个交易日，和它用的 20 日涨幅对齐。",
  },
  {
    id: "flow",
    name: "主力吸筹",
    holdDays: 5,
    hint: "盘中看主力净流入超过 3000 万、且还没封死涨停。没有成交时，改为近 5 日转强。预计持股 5 个交易日。",
  },
  {
    id: "rebound",
    name: "超跌修复",
    holdDays: 10,
    hint: "20 日和 60 日都至少回撤 12%，同时市盈率不超过 35 倍、市净率不超过 4 倍。预计持股 10 个交易日。",
  },
  {
    id: "active",
    name: "放量启动",
    holdDays: 3,
    hint: "盘中量比至少 1.6、换手 3% 到 20%、当天上涨但未涨停。预计持股 3 个交易日。",
  },
  {
    id: "t1",
    name: "次日卖出",
    holdDays: 1,
    hint: "已停用，不要按它下单。规则本身只持有 1 个交易日，下一交易日卖。",
  },
  {
    id: "custom",
    name: "自定义",
    holdDays: null,
    hint: "不套用模型门槛，只按你填的条件筛选。持股天数没有预设，要你自己写。",
  },
];

export function resolveHold(id: StrategyId, customDays: number): number | null {
  if (id === "custom") return customDays >= 1 ? Math.round(customDays) : null;
  return STRATEGIES.find((item) => item.id === id)?.holdDays ?? null;
}

export const BOARD_LABEL: Record<Board, string> = {
  sh: "沪市",
  sz: "深市",
  cyb: "创业",
  kcb: "科创",
  bj: "北证",
};

export function emptyFilters(): Filters {
  return {
    q: "",
    boards: [],
    excludeSt: true,
    peMin: "",
    peMax: "",
    pbMin: "",
    pbMax: "",
    capMin: "",
    capMax: "",
    chgMin: "",
    chgMax: "",
    d20Min: "",
    d20Max: "",
    d60Min: "",
    d60Max: "",
    hslMin: "",
    inflowMin: "",
  };
}

export function isIdleBook(quotes: Quote[]): boolean {
  if (quotes.length === 0) return true;
  let live = 0;
  for (const quote of quotes) {
    if (quote.amount > 0 || quote.turnover > 0) live += 1;
  }
  return live / quotes.length < 0.08;
}

export function limitPct(quote: Quote): number {
  if (quote.st) return 5;
  if (quote.board === "cyb" || quote.board === "kcb") return 20;
  if (quote.board === "bj") return 30;
  return 10;
}

export function limitTag(quote: Quote): "涨停" | "跌停" | null {
  if (quote.chg == null) return null;
  const limit = limitPct(quote);
  if (quote.chg >= limit - 0.15) return "涨停";
  if (quote.chg <= -limit + 0.15) return "跌停";
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function peOk(quote: Quote, max: number): boolean {
  return quote.pe != null && quote.pe > 0 && quote.pe <= max;
}

function pbOk(quote: Quote, max: number): boolean {
  return quote.pb != null && quote.pb > 0 && quote.pb <= max;
}

function notSealedUp(quote: Quote): boolean {
  if (quote.chg == null) return true;
  return quote.chg < limitPct(quote) - 0.3;
}

function notSealedDown(quote: Quote): boolean {
  if (quote.chg == null) return true;
  return quote.chg > -limitPct(quote) + 0.3;
}

function pct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = `${Math.abs(n).toFixed(1)}%`;
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

function topReasons(parts: { t: string; p: number }[]): string[] {
  return parts
    .filter((part) => part.p > 0)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .map((part) => part.t);
}

function done(parts: { t: string; p: number }[], extra = 0): Scored {
  const score = Math.round(clamp(parts.reduce((sum, part) => sum + part.p, 0) + extra, 0, 100));
  return { score, reasons: topReasons(parts) };
}

export const T1_RECORD = {
  stocks: 277,
  trades: 2098,
  winPct: 52.8,
  grossPct: 0.31,
  netPct: 0.16,
  costPct: 0.15,
};

export type T1Ticket = {
  prev: number;
  buy: number;
  sell: number;
  low: number;
  high: number;
  limitDown: number;
};

export function t1Ticket(quote: Quote): T1Ticket | null {
  if (!(quote.price > 0) || quote.chg == null) return null;
  const prev = quote.price / (1 + quote.chg / 100);
  if (!(prev > 0)) return null;
  const buy = quote.price;
  return {
    prev,
    buy,
    sell: buy * (1 + T1_RECORD.grossPct / 100),
    low: prev * 0.94,
    high: prev * 0.98,
    limitDown: prev * (1 - limitPct(quote) / 100),
  };
}

export function t1BuyText(ticket: T1Ticket, sellDay: string): string {
  const p = (n: number) => n.toFixed(2);
  return `尚未成交。预期买入 ${p(ticket.buy)}，限价不要高于现价。允许 ${p(ticket.low)}–${p(ticket.high)}（昨收 ${p(ticket.prev)} 的 -6% 到 -2%）。涨过 ${p(ticket.high)} 不要买，跌停 ${p(ticket.limitDown)} 放弃。预期卖出 ${p(ticket.sell)}，按历史平均毛收益 +${T1_RECORD.grossPct}% 折算，不是目标单。最早 ${sellDay} 卖。`;
}

function scoreT1(quote: Quote, live: boolean, tail: boolean): Scored | null {
  if (!live || quote.st || quote.price < 4 || quote.cap < 30) return null;
  if (quote.chg == null || quote.d5 == null || quote.d20 == null) return null;
  const limit = limitPct(quote);
  if (quote.chg <= -limit + 1.2) return null;
  if (quote.chg > -2 || quote.chg < -6) return null;
  if (quote.d5 > -3 || quote.d20 < -15) return null;
  if (quote.volRatio < 0.8 || quote.volRatio > 3) return null;
  const amountFloor = tail ? 8000 : 2000;
  if (quote.amount < amountFloor) return null;

  const dropPts = clamp(((-quote.chg - 2) / 4) * 28, 0, 28);
  const d5Pts = clamp(((-quote.d5 - 3) / 8) * 24, 0, 24);
  const lbPts = quote.volRatio >= 1 && quote.volRatio <= 2.2 ? 18 : 10;
  const liqPts = clamp((Math.log10(quote.amount / amountFloor) + 0.1) * 12, 4, 18);
  const holdPts = quote.d20 >= -8 ? 12 : 6;
  return done([
    { t: `今日 ${pct(quote.chg)}，没有贴跌停`, p: dropPts },
    { t: `5 日 ${pct(quote.d5)}`, p: d5Pts },
    { t: `量比 ${quote.volRatio.toFixed(2)}`, p: lbPts },
    { t: tail ? "成交额达到尾盘门槛" : "成交还在累积，先别下单", p: liqPts },
    { t: `20 日 ${pct(quote.d20)}`, p: holdPts },
  ]);
}

function scoreEarly(quote: Quote, live: boolean, strict: boolean, rules: EarlyRules = DEFAULT_RULES): Scored | null {
  if (!live || quote.st || quote.price < 4 || quote.cap < 40) return null;
  if (quote.chg == null || quote.d5 == null || quote.d20 == null || quote.d60 == null) return null;
  if (!notSealedUp(quote) || !notSealedDown(quote)) return null;
  if (quote.chg < rules.chgMin || quote.chg > rules.chgMax) return null;
  if (quote.d5 < rules.d5Min || quote.d5 > rules.d5Max) return null;
  if (quote.d20 < rules.d20Min || quote.d20 > rules.d20Max) return null;
  if (quote.d60 < rules.d60Min || quote.d60 > rules.d60Max) return null;
  if (quote.volRatio < rules.volMin || quote.volRatio > rules.volMax) return null;
  if (quote.turnover < rules.turnMin || quote.turnover > rules.turnMax) return null;
  if (quote.amount < (strict ? rules.amountMin : Math.min(rules.amountMin, 1500))) return null;

  const span20 = Math.max(1, rules.d20Max - rules.d20Min);
  const span5 = Math.max(1, rules.d5Max - rules.d5Min);
  const spanChg = Math.max(0.5, rules.chgMax - rules.chgMin);
  const early = clamp(((rules.d20Max - quote.d20) / span20) * 40, 0, 40);
  const fresh = clamp(((rules.d5Max - quote.d5) / span5) * 30, 0, 30);
  const vol = quote.volRatio <= (rules.volMin + rules.volMax) / 2 ? 20 : 10;
  const day = clamp(((rules.chgMax - quote.chg) / spanChg) * 10, 0, 10);
  return done([
    { t: `20 日 ${pct(quote.d20)}，还没走远`, p: early },
    { t: `5 日 ${pct(quote.d5)}，刚转强`, p: fresh },
    { t: `量比 ${quote.volRatio.toFixed(2)}`, p: vol },
    { t: `今日 ${pct(quote.chg)}`, p: day },
  ]);
}

function scoreBlend(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.price < 3 || quote.cap < 60) return null;
  if (!peOk(quote, 40) || !pbOk(quote, 5)) return null;
  if (quote.d60 == null || quote.d60 < -25) return null;
  if (quote.d20 == null || quote.d20 < -20) return null;
  if (!notSealedDown(quote)) return null;
  if (live && quote.amount < 2000) return null;

  const pe = quote.pe ?? 0;
  const pb = quote.pb ?? 0;
  let pePts = 0;
  if (pe >= 8 && pe <= 22) pePts = 28 - Math.abs(pe - 14) * 0.8;
  else if (pe < 8) pePts = 14;
  else pePts = 16 - (pe - 22) * 0.6;
  pePts = clamp(pePts, 0, 28);
  const pbPts = clamp(((5 - pb) / 5) * 16, 0, 16);

  let trend = 0;
  if (quote.d60 >= 0 && quote.d60 <= 35) trend += 12;
  else if (quote.d60 > 35) trend += 6;
  else trend += clamp(6 + quote.d60 / 8, 0, 6);
  if (quote.d20 >= 0 && quote.d20 <= 18) trend += 12;
  else if (quote.d20 > 18 && quote.d20 <= 35) trend += 6;
  else trend += clamp(4 + quote.d20 / 8, 0, 4);
  trend = clamp(trend, 0, 24);
  const size = quote.cap >= 100 && quote.cap <= 4000 ? 8 : 4;
  const parts = [
    { t: `市盈率 ${pe.toFixed(1)} 倍`, p: pePts },
    { t: `市净率 ${pb.toFixed(2)} 倍`, p: pbPts },
    { t: `20 日 ${pct(quote.d20)} · 60 日 ${pct(quote.d60)}`, p: trend },
    { t: `总市值 ${Math.round(quote.cap)} 亿`, p: size },
  ];
  if (live) {
    const intensity = quote.floatCap > 0 ? quote.inflow / (quote.floatCap * 10000) : 0;
    const flowPts = quote.inflow > 0 ? clamp((intensity / 0.004) * 14, 4, 14) : 0;
    const hslPts =
      quote.turnover >= 0.6 && quote.turnover <= 8 ? 10 : quote.turnover > 8 && quote.turnover <= 15 ? 5 : 2;
    if (flowPts >= 4) parts.push({ t: "主力净流入为正", p: flowPts });
    parts.push({ t: `换手 ${quote.turnover.toFixed(1)}%`, p: hslPts });
    return done(parts);
  }
  const ytd = quote.ytd;
  const yPts = ytd == null ? 4 : ytd >= -10 && ytd <= 30 ? 12 : ytd > 30 ? 6 : clamp(6 + ytd / 5, 0, 6);
  parts.push({ t: `年初至今 ${pct(ytd)}`, p: yPts });
  return done(parts);
}

function scoreValue(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.price < 2 || quote.cap < 80) return null;
  if (!peOk(quote, 16) || !pbOk(quote, 1.8)) return null;
  if (quote.d60 == null || quote.d60 < -35) return null;
  if (live && quote.amount > 0 && quote.amount < 800) return null;
  const pe = quote.pe ?? 0;
  const pb = quote.pb ?? 0;
  const pePts = clamp(((16 - pe) / 16) * 40, 0, 40);
  const pbPts = clamp(((1.8 - pb) / 1.8) * 25, 0, 25);
  const stab = quote.d60 > -10 && quote.d60 < 25 ? 20 : quote.d60 >= 25 ? 10 : clamp(12 + quote.d60 / 4, 0, 12);
  const size = quote.cap >= 200 ? 15 : quote.cap >= 100 ? 10 : 6;
  return done([
    { t: `市盈率 ${pe.toFixed(1)} 倍`, p: pePts },
    { t: `市净率 ${pb.toFixed(2)} 倍`, p: pbPts },
    { t: `60 日 ${pct(quote.d60)}`, p: stab },
    { t: `总市值 ${Math.round(quote.cap)} 亿`, p: size },
  ]);
}

function scoreMomentum(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.price < 4 || quote.cap < 30) return null;
  if (quote.d20 == null || quote.d60 == null || quote.d5 == null) return null;
  if (quote.d20 < 10 || quote.d60 < 8 || quote.d5 < 0 || quote.d20 > 80) return null;
  if (quote.pe != null && quote.pe <= 0) return null;
  if (!notSealedUp(quote)) return null;
  if (live && (quote.volRatio < 0.8 || quote.turnover > 30 || quote.amount < 3000)) return null;
  const d20Pts = clamp(((Math.min(quote.d20, 45) - 10) / 35) * 34, 0, 34);
  const d60Pts = clamp(((Math.min(quote.d60, 60) - 8) / 52) * 24, 0, 24);
  const d5Pts = clamp((Math.min(quote.d5, 12) / 12) * 18, 0, 18);
  const parts = [
    { t: `20 日 ${pct(quote.d20)}`, p: d20Pts },
    { t: `60 日 ${pct(quote.d60)}`, p: d60Pts },
    { t: `5 日 ${pct(quote.d5)}`, p: d5Pts },
  ];
  if (live) {
    const lbPts = quote.volRatio >= 1 && quote.volRatio <= 3.5 ? 14 : quote.volRatio > 3.5 ? 6 : 2;
    const flowPts = quote.inflow > 0 ? 10 : 0;
    parts.push({ t: `量比 ${quote.volRatio.toFixed(2)}`, p: lbPts });
    if (flowPts) parts.push({ t: "主力净流入为正", p: flowPts });
    return done(parts);
  }
  const yPts = quote.ytd != null && quote.ytd > 0 ? 16 : 6;
  parts.push({ t: `年初至今 ${pct(quote.ytd)}`, p: yPts });
  return done(parts);
}

function scoreFlow(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.cap < 40 || quote.price < 2) return null;
  if (!notSealedUp(quote)) return null;
  if (live) {
    if (quote.inflow < 3000 || quote.amount < 2000) return null;
    const intensity = quote.floatCap > 0 ? quote.inflow / (quote.floatCap * 10000) : 0;
    const flowPts = clamp((intensity / 0.006) * 55, 18, 55);
    const pace = quote.chg == null ? 12 : quote.chg >= 0 && quote.chg <= 6 ? 25 : quote.chg < 0 ? 12 : 8;
    const capPts = quote.cap >= 80 && quote.cap <= 3000 ? 20 : 10;
    return done([
      { t: `主力净流入 ${(quote.inflow / 10000).toFixed(2)} 亿`, p: flowPts },
      { t: quote.chg == null ? "涨跌待定" : `今日 ${pct(quote.chg)}`, p: pace },
      { t: `流通市值 ${Math.round(quote.floatCap)} 亿`, p: capPts },
    ]);
  }
  if (quote.d5 == null || quote.d20 == null || quote.d60 == null) return null;
  if (quote.d5 < 1 || quote.d20 < 3 || quote.d20 > 25) return null;
  if (!peOk(quote, 60)) return null;
  const d5Pts = clamp((Math.min(quote.d5, 8) / 8) * 40, 0, 40);
  const d20Pts = clamp(quote.d20 <= 15 ? 30 : 30 - (quote.d20 - 15) * 2, 8, 30);
  const pePts = clamp(((60 - (quote.pe ?? 60)) / 60) * 18, 0, 18);
  const d60Pts = quote.d60 > 0 ? 10 : 4;
  return done([
    { t: `5 日 ${pct(quote.d5)}`, p: d5Pts },
    { t: `20 日 ${pct(quote.d20)}，尚未过热`, p: d20Pts },
    { t: `市盈率 ${(quote.pe ?? 0).toFixed(1)} 倍`, p: pePts },
    { t: `60 日 ${pct(quote.d60)}`, p: d60Pts },
  ]);
}

function scoreRebound(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.cap < 40 || quote.price < 2) return null;
  if (quote.d20 == null || quote.d60 == null) return null;
  if (quote.d20 > -12 || quote.d60 > -12) return null;
  if (!peOk(quote, 35) || !pbOk(quote, 4)) return null;
  if (quote.chg != null && quote.chg < -4) return null;
  if (live && quote.amount > 0 && quote.amount < 1000) return null;
  const d20Pts = clamp(((-quote.d20 - 12) / 25) * 36, 0, 36);
  const d60Pts = clamp(((-quote.d60 - 12) / 40) * 22, 0, 22);
  const pePts = clamp(((35 - (quote.pe ?? 35)) / 35) * 24, 0, 24);
  const pbPts = clamp(((4 - (quote.pb ?? 4)) / 4) * 10, 0, 10);
  const stab = quote.chg == null ? 6 : quote.chg >= 0 ? 12 : 4;
  return done([
    { t: `20 日 ${pct(quote.d20)}`, p: d20Pts },
    { t: `60 日 ${pct(quote.d60)}`, p: d60Pts },
    { t: `市盈率 ${(quote.pe ?? 0).toFixed(1)} 倍`, p: pePts },
    { t: `市净率 ${(quote.pb ?? 0).toFixed(2)} 倍`, p: pbPts + stab },
  ]);
}

function scoreActive(quote: Quote, live: boolean): Scored | null {
  if (quote.st || quote.price < 3 || quote.cap < 20 || quote.cap > 800) return null;
  if (!peOk(quote, 80)) return null;
  if (live) {
    if (quote.volRatio < 1.6 || quote.turnover < 3 || quote.turnover > 20) return null;
    if (quote.chg == null || quote.chg <= 0 || quote.chg >= Math.min(8, limitPct(quote) - 0.4)) return null;
    if (quote.d20 != null && quote.d20 > 30) return null;
    if (quote.amount < 2500) return null;
    const lbPts = clamp(((Math.min(quote.volRatio, 4) - 1.6) / 2.4) * 36, 0, 36);
    const hslPts = quote.turnover <= 12 ? 24 : 12;
    const chgPts = quote.chg <= 5 ? 24 : 12;
    const flowPts = quote.inflow > 0 ? 14 : 4;
    return done([
      { t: `量比 ${quote.volRatio.toFixed(2)}`, p: lbPts },
      { t: `换手 ${quote.turnover.toFixed(1)}%`, p: hslPts },
      { t: `今日 ${pct(quote.chg)}`, p: chgPts },
      { t: quote.inflow > 0 ? "主力净流入为正" : "主力尚未流入", p: flowPts },
    ]);
  }
  if (quote.d5 == null || quote.d20 == null) return null;
  if (quote.d5 < 2 || quote.d5 > 12 || quote.d20 < -8 || quote.d20 > 15) return null;
  const d5Pts = clamp(((quote.d5 - 2) / 10) * 42, 8, 42);
  const d20Pts = clamp(32 - Math.abs(quote.d20 - 4) * 1.6, 0, 32);
  const pePts = (quote.pe ?? 80) <= 40 ? 18 : 8;
  return done([
    { t: `5 日 ${pct(quote.d5)}`, p: d5Pts },
    { t: `20 日 ${pct(quote.d20)}`, p: d20Pts },
    { t: `市盈率 ${(quote.pe ?? 0).toFixed(1)} 倍`, p: pePts },
  ]);
}

export function evaluate(
  id: StrategyId,
  quote: Quote,
  live: boolean,
  tail = false,
  rules: EarlyRules = DEFAULT_RULES,
): Scored | null {
  switch (id) {
    case "early":
      return scoreEarly(quote, live, tail, rules);
    case "t1":
      return scoreT1(quote, live, tail);
    case "blend":
      return scoreBlend(quote, live);
    case "value":
      return scoreValue(quote, live);
    case "momentum":
      return scoreMomentum(quote, live);
    case "flow":
      return scoreFlow(quote, live);
    case "rebound":
      return scoreRebound(quote, live);
    case "active":
      return scoreActive(quote, live);
    default:
      return null;
  }
}

function readBound(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function within(n: number | null, minRaw: string, maxRaw: string): boolean {
  const min = readBound(minRaw);
  const max = readBound(maxRaw);
  if (min == null && max == null) return true;
  if (n == null || !Number.isFinite(n)) return false;
  if (min != null && n < min) return false;
  if (max != null && n > max) return false;
  return true;
}

export function passesFilters(quote: Quote, filters: Filters, idle: boolean): boolean {
  const keyword = filters.q.trim();
  if (keyword && !quote.name.includes(keyword) && !quote.code.includes(keyword) && !quote.id.includes(keyword)) {
    return false;
  }
  if (filters.boards.length > 0 && !filters.boards.includes(quote.board)) return false;
  if (filters.excludeSt && quote.st) return false;
  if (!within(quote.pe, filters.peMin, filters.peMax)) return false;
  if (!within(quote.pb, filters.pbMin, filters.pbMax)) return false;
  if (!within(quote.cap, filters.capMin, filters.capMax)) return false;
  if (!within(quote.chg, filters.chgMin, filters.chgMax)) return false;
  if (!within(quote.d20, filters.d20Min, filters.d20Max)) return false;
  if (!within(quote.d60, filters.d60Min, filters.d60Max)) return false;
  if (!idle) {
    const hslMin = readBound(filters.hslMin);
    if (hslMin != null && quote.turnover < hslMin) return false;
    const inflowMin = readBound(filters.inflowMin);
    if (inflowMin != null && quote.inflow < inflowMin) return false;
  }
  return true;
}

export function filtersDirty(filters: Filters): boolean {
  const base = emptyFilters();
  return (Object.keys(base) as (keyof Filters)[]).some((key) => {
    const value = filters[key];
    const initial = base[key];
    if (Array.isArray(value) && Array.isArray(initial)) return value.length !== initial.length;
    return value !== initial;
  });
}

export function defaultDir(key: SortKey): "asc" | "desc" {
  return key === "pe" || key === "pb" ? "asc" : "desc";
}

export function compareMetric(
  a: number | null,
  b: number | null,
  dir: "asc" | "desc",
): number {
  const aMissing = a == null || !Number.isFinite(a);
  const bMissing = b == null || !Number.isFinite(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return dir === "asc" ? a - b : b - a;
}
