/**
 * 这个文件是干什么的：
 * 全项目共用的「名词表」。行情、K 线、今天是不是交易时段，都用这里的形状。
 *
 * 你需要知道的：
 * 金额单位不统一，看每个字段后面的说明。改字段名会让页面和记账一起坏。
 */

/** 股票在哪个市场。涨跌停幅度跟这个有关：主板 10%，创业板和科创板 20%，北证 30%。 */
export type Board = "sh" | "sz" | "cyb" | "kcb" | "bj";

/** 一只股票此刻的行情。选股和记账都读这一份，不再各拉各的。 */
export type Quote = {
  /** 内部编号，带市场前缀，例如 sh600519。账本里用它当股票 id。 */
  id: string;
  /** 六位代码，给人看的，例如 600519。 */
  code: string;
  name: string;
  board: Board;
  /** 现价，单位元。 */
  price: number;
  /** 今天相对昨收的涨跌幅，单位是百分比。涨 1.5% 写成 1.5。没有行情时是 null。 */
  chg: number | null;
  /** 市盈率，倍数。没有或亏损时可能是 null。 */
  pe: number | null;
  /** 市净率，倍数。 */
  pb: number | null;
  /** 总市值，单位亿元。 */
  cap: number;
  /** 流通市值，单位亿元。 */
  floatCap: number;
  /** 换手率，百分比。换手 3% 写成 3。 */
  turnover: number;
  /** 量比。1 表示和近期差不多，大于 1 表示今天放量。 */
  volRatio: number;
  /** 振幅，百分比。 */
  amp: number;
  /** 近 5 个交易日涨跌幅，百分比。 */
  d5: number | null;
  /** 近 10 个交易日涨跌幅，百分比。 */
  d10: number | null;
  /** 近 20 个交易日涨跌幅，百分比。启动前期用它判断「还没走远」。 */
  d20: number | null;
  /** 近 60 个交易日涨跌幅，百分比。 */
  d60: number | null;
  /** 今年以来涨跌幅，百分比。 */
  ytd: number | null;
  /** 主力净流入，单位万元。正数是流入，负数是流出。 */
  inflow: number;
  /** 今天成交额，单位万元。 */
  amount: number;
  /** 是不是 ST 或名字里带退市风险。这类票不进选股。 */
  st: boolean;
};

/** 分时图上的一个点。time 是 HHMM 四位文本，price 是点位。 */
export type TrendPoint = { time: string; price: number };

/** 一只指数最近一个交易日的分钟走势。prevClose 是昨收，画基准线用；拉不到是 null。 */
export type Trend = {
  id: string;
  /** 交易日，YYYYMMDD。 */
  date: string;
  prevClose: number | null;
  points: TrendPoint[];
};

/** 指数行情，例如沪深 300。用来和个股比「有没有跑赢」。 */
export type IndexQuote = {
  id: string;
  name: string;
  price: number;
  /** 涨跌点数。 */
  chg: number;
  /** 涨跌幅，百分比。 */
  pct: number;
  time: string;
};

/** 一次拉下来的全市场名单。 */
export type Universe = {
  quotes: Quote[];
  /** 这份名单是什么时候拿到的，毫秒时间戳。 */
  asOf: number;
  total: number;
  /** 没拉全，页面上要标明不完整。 */
  partial: boolean;
  /** 太旧了，不能当现价用。 */
  stale: boolean;
  /** 这份名单来自哪个数据源。腾讯是主源，东财是备份。 */
  source?: "tencent" | "eastmoney";
};

/** 一根日 K。日期是 YYYY-MM-DD，价格是元，v 是成交量。 */
export type Bar = {
  date: string;
  o: number;
  c: number;
  h: number;
  l: number;
  v: number;
};

/** 今天走到哪一段。只看上海时间。 */
export type SessionPhase = "pre" | "auction" | "morning" | "lunch" | "afternoon" | "closed";

export type SessionInfo = {
  phase: SessionPhase;
  /** 给人看的状态，例如「交易中」「午间休市」。 */
  label: string;
  /** 现在能不能成交。午休和收盘后是 false。 */
  open: boolean;
  /** 连续竞价或收盘集合竞价之后，限价单才可能成交。9:15–9:30 和午休不算。 */
  matching: boolean;
  /** 14:30 之后，含收盘。次日补涨只在这段买入。 */
  tailHalf: boolean;
  /** 14:40 到 15:00，尾盘买入窗口。 */
  tail: boolean;
  /** none 不是买入窗口；open 是 9:25–9:30；close 是 14:40–15:00。 */
  entry: "none" | "open" | "close";
  /** 下一交易日的日期文字，用来提示最早什么时候能卖。 */
  nextSell: string;
  /** 上海日期，YYYY-MM-DD。 */
  date: string;
  /** 已经过了 15:00，今天的价收住了。 */
  sealed: boolean;
};
