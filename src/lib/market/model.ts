import type { Board, Quote } from "@/lib/market/types";
import { DEFAULT_RULES, type EarlyRules } from "@/lib/market/rules";

export type Scored = { score: number; reasons: string[] };

/** 样本要满这么多交易日，上涨占比才不算太短。不是持股天数。 */
export const TRACK_NEED = 60;

export const BOARD_LABEL: Record<Board, string> = {
  sh: "沪市",
  sz: "深市",
  cyb: "创业",
  kcb: "科创",
  bj: "北证",
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
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

/** 几乎没有成交时，量比和成交额没有意义。 */
export function isIdleBook(quotes: Quote[]): boolean {
  if (quotes.length === 0) return true;
  let live = 0;
  for (const quote of quotes) {
    if (quote.amount > 0 || quote.turnover > 0) live += 1;
  }
  return live / quotes.length < 0.08;
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

/**
 * 启动前期：刚转强、20 日还没走远。条件收窄是为了少追、少接飞刀，不是为了把历史涨幅调到最好看。
 * 涨跌停和 ST 直接排除。门槛来自 rules，改规则会换版本。
 * 卖出不在这里：跌 5% 止损，涨 8% 止盈，否则第 8 个交易日收盘卖。
 */
export function screen(quote: Quote, live: boolean, rules: EarlyRules = DEFAULT_RULES): Scored | null {
  if (!live || quote.st || quote.price < 4 || quote.cap < 40) return null;
  if (quote.chg == null || quote.d5 == null || quote.d20 == null || quote.d60 == null) return null;
  if (!notSealedUp(quote) || !notSealedDown(quote)) return null;
  if (quote.chg < rules.chgMin || quote.chg > rules.chgMax) return null;
  if (quote.d5 < rules.d5Min || quote.d5 > rules.d5Max) return null;
  if (quote.d20 < rules.d20Min || quote.d20 > rules.d20Max) return null;
  if (quote.d60 < rules.d60Min || quote.d60 > rules.d60Max) return null;
  if (quote.volRatio < rules.volMin || quote.volRatio > rules.volMax) return null;
  if (quote.turnover < rules.turnMin || quote.turnover > rules.turnMax) return null;
  if (quote.amount < rules.amountMin) return null;

  const span20 = Math.max(1, rules.d20Max - rules.d20Min);
  const span5 = Math.max(1, rules.d5Max - rules.d5Min);
  const spanChg = Math.max(0.5, rules.chgMax - rules.chgMin);
  const parts = [
    { t: `20 日 ${pct(quote.d20)}，还没走远`, p: clamp(((rules.d20Max - quote.d20) / span20) * 40, 0, 40) },
    { t: `5 日 ${pct(quote.d5)}，刚转强`, p: clamp(((rules.d5Max - quote.d5) / span5) * 30, 0, 30) },
    { t: `量比 ${quote.volRatio.toFixed(2)}`, p: quote.volRatio <= (rules.volMin + rules.volMax) / 2 ? 20 : 10 },
    { t: `今日 ${pct(quote.chg)}`, p: clamp(((rules.chgMax - quote.chg) / spanChg) * 10, 0, 10) },
  ];
  const score = Math.round(clamp(parts.reduce((sum, part) => sum + part.p, 0), 0, 100));
  const reasons = parts
    .filter((part) => part.p > 0)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .map((part) => part.t);
  return { score, reasons };
}
