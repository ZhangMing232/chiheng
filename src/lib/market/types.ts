export type Board = "sh" | "sz" | "cyb" | "kcb" | "bj";

export type Quote = {
  id: string;
  code: string;
  name: string;
  board: Board;
  price: number;
  chg: number | null;
  pe: number | null;
  pb: number | null;
  cap: number;
  floatCap: number;
  turnover: number;
  volRatio: number;
  amp: number;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d60: number | null;
  ytd: number | null;
  inflow: number;
  amount: number;
  st: boolean;
};

export type IndexQuote = {
  id: string;
  name: string;
  price: number;
  chg: number;
  pct: number;
  time: string;
};

export type Universe = {
  quotes: Quote[];
  asOf: number;
  total: number;
  partial: boolean;
  stale: boolean;
};

export type Bar = {
  date: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
};

export type SessionPhase = "pre" | "auction" | "morning" | "lunch" | "afternoon" | "closed";

export type SessionInfo = {
  phase: SessionPhase;
  label: string;
  open: boolean;
  /** 连续竞价或收盘集合竞价之后，限价单才可能成交。9:15–9:30 和午休不算。 */
  matching: boolean;
  /** 14:30 之后，含收盘。次日补涨只在这段买入。 */
  tailHalf: boolean;
  tail: boolean;
  entry: "none" | "open" | "close";
  nextSell: string;
  date: string;
  sealed: boolean;
};
