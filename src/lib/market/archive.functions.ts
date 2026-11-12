/**
 * 这个文件是干什么的：
 * 四个「档案类」页面的读数入口——前瞻回验 / 趋势中军 RS 榜 / 区间统计 / 席位档案。
 *
 * 你需要知道的：
 * - 四个页面读的都是**构建脚本预先算好的产物**（data/history/ 下面），页面不现算。
 *   现算 5000 只票的区间涨幅要几秒，SSR 首页会卡；预计算 + 读 JSON 是毫秒级。
 * - 读不到文件时**返回 null，不返回空壳**。页面拿 null 就显示「还没生成」，
 *   跟「算出来是空的」区分开——这是全站口径纪律。
 * - 区间统计只读收盘价，所以能给涨幅、不能给「区间净额」（资金流只覆盖 343 只）。
 *   这个缺口在页面正文里写明，不用 0 顶替。
 */

import { createServerFn } from "@tanstack/react-start";

// ─────────────────────────── 前瞻回验 ───────────────────────────

export type ForecastPick = { code: string; name: string; rule: string; basis: { streak: number; volRatio: number; close: number } };
export type ForecastOutcome = {
  code: string;
  name: string;
  rule: string;
  /**
   * 结算用到的三个真实价（都是盘后才知道，不含未来函数）：
   *   pickPrice = T 日收盘（选股当时看到的价格）
   *   buyPrice  = T+1 开盘（最早能成交的买入价）
   *   sellPrice = T+1 收盘（结算卖出的价）
   *   highPrice = T+1 最高（判断「追买」用）
   * 页面拿这三个价画时间线，不再自己算涨跌，避免口径漂移。
   */
  pickPrice: number | null;
  buyPrice: number | null;
  sellPrice: number | null;
  highPrice: number | null;
  /** 真实交易盈亏：T+1 开盘买入、T+1 收盘卖出 = sellPrice/buyPrice - 1 */
  tradePct: number | null;
  /** T 日收盘 → T+1 收盘：方向命中的基准口径，和全市场基准对齐 */
  holdPct: number | null;
  /** T+1 最高相对买入价：追买幅度 = highPrice/buyPrice - 1 */
  highPct: number | null;
  // —— 旧字段保留作别名，regenerate 后会写同样的值，避免旧 backtest.json 读出 undefined ——
  nextPct: number | null;
  nextHighPct: number | null;
  nextOpenToClose: number | null;
  limitUp: boolean;
  hit: boolean;
  chase: boolean;
  /** 买入日能不能买到：false = 一字涨停，开盘挂单排不进 */
  buyFilled?: boolean | null;
  /** 结算日能不能卖掉：false = 一字跌停，挂跌停也卖不出 */
  sellFilled?: boolean | null;
  /** 成交性说明（为什么买不进 / 为什么要打折看） */
  fillNote?: string | null;
};
export type ForecastLiveRow = {
  code: string;
  name: string;
  rule: string;
  buyPrice: number | null;
  last: number | null;
  high: number | null;
  low: number | null;
  pctFromBuy: number | null;
  limitUpPrice: number | null;
  buyFilled: boolean | null;
  fillNote: string | null;
};
/**
 * 「今天正是买入日、还没收盘结算」这一段。
 * 来源 scripts/forecast-live.ts 写的 data/history/forecast/live/<落档日>.json，
 * **不回写落档文件**——落档是凭据，落档之后不许改。
 */
export type ForecastLive = {
  date: string;
  nextDate: string | null;
  asOf: string;
  final: boolean;
  rows: ForecastLiveRow[];
};
export type ForecastPeriod = {
  date: string;
  nextDate: string | null;
  lockedAt?: string;
  source: "locked" | "backtest";
  picks: ForecastPick[];
  outcomes?: ForecastOutcome[];
  summary?: { hits: number; chases: number; n: number; limitUps: number; unfilled?: number; stuck?: number };
  /** 未结算的期才有：买入日已经开盘，买入价是真实成交价，现价是盘中值 */
  live?: ForecastLive;
};
export type ForecastPayload = {
  locked: ForecastPeriod[];
  backtest: { periods: ForecastPeriod[]; baseline: { n: number; upRate: number | null; chaseRate: number | null } | null; note: string } | null;
};

export const getForecast = createServerFn({ method: "GET" }).handler(async (): Promise<ForecastPayload> => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = "data/history/forecast";
  let locked: ForecastPeriod[] = [];
  try {
    const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const rows = await Promise.all(
      files.map(async (f) => {
        try {
          return JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as ForecastPeriod;
        } catch {
          return null;
        }
      }),
    );
    locked = rows.filter((r): r is ForecastPeriod => Boolean(r)).reverse();
  } catch {
    locked = [];
  }
  // 「买入日已经开盘、还没收盘结算」的实况：只给还没结算的期补，已结算的期不许两套口径打架
  try {
    const liveFiles = (await readdir(`${dir}/live`)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    const liveRows = await Promise.all(
      liveFiles.map(async (f) => {
        try {
          return JSON.parse(await readFile(`${dir}/live/${f}`, "utf8")) as ForecastLive;
        } catch {
          return null;
        }
      }),
    );
    const byDate = new Map<string, ForecastLive>();
    for (const l of liveRows) if (l && l.date) byDate.set(l.date, l);
    locked = locked.map((p) => {
      if (p.summary && p.summary.n > 0) return p;
      const l = byDate.get(p.date);
      return l ? { ...p, live: l, nextDate: p.nextDate ?? l.nextDate } : p;
    });
  } catch {
    // 没有 live 目录就照旧——盘中没有实况比编一个数好
  }
  let backtest: ForecastPayload["backtest"] = null;
  try {
    const raw = JSON.parse(await readFile(`${dir}/backtest.json`, "utf8")) as {
      periods: ForecastPeriod[];
      baseline: { n: number; upRate: number | null; chaseRate: number | null } | null;
      note: string;
    };
    backtest = { periods: [...raw.periods].reverse(), baseline: raw.baseline ?? null, note: raw.note };
  } catch {
    backtest = null;
  }
  return { locked, backtest };
});

// ─────────────────────────── RS 榜 ───────────────────────────

export type RsRow = {
  id: string;
  name: string;
  rs: number;
  raw: number;
  r20: number;
  r60: number;
  r120: number;
  r250: number;
  fromHigh: number;
  amount: number;
  cap: number;
  industry: string;
};
export type RsPayload = {
  date: string;
  generatedAt: string;
  universe: number;
  stale: number;
  medianRaw: number;
  minAmountWan: number;
  weights: number[];
  rows: RsRow[];
};

export const getRs = createServerFn({ method: "GET" }).handler(async (): Promise<RsPayload | null> => {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile("data/history/rs/latest.json", "utf8")) as RsPayload;
  } catch {
    return null;
  }
});

// ─────────────────────────── 席位档案 ───────────────────────────

export type SeatRecord = { date: string; stock: string; id: string | null; netWan: number; r1: number | null; r5: number | null };
export type SeatRow = {
  name: string;
  days: number;
  netWan: number;
  buys: number;
  avg1: number | null;
  avg5: number | null;
  win5: number | null;
  n5: number;
  first: string;
  last: string;
  recs: SeatRecord[];
};
export type SeatsPayload = {
  generatedAt: string;
  hold: number;
  minDays: number;
  sourceDays: number;
  sourceFirst: string;
  sourceLast: string;
  unresolved: number;
  seats: SeatRow[];
  latest: { date: string; seats: { name: string; netWan: number; stocks: { name: string; netWan: number }[] }[] } | null;
};

export const getSeats = createServerFn({ method: "GET" }).handler(async (): Promise<SeatsPayload | null> => {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile("data/history/seats/latest.json", "utf8")) as SeatsPayload;
  } catch {
    return null;
  }
});

// ─────────────────────────── 区间统计 ───────────────────────────

export type IntervalStock = { id: string; name: string; from: number; to: number; chg: number };
export type IntervalBoard = { name: string; members: number; covered: number; median: number; top: string };
export type IntervalPayload = {
  from: string;
  to: string;
  /** 区间内实际有多少个交易日 */
  sessions: number;
  covered: number;
  stocks: IntervalStock[];
  boards: IntervalBoard[];
  /** 首尾两个快照都有的票数比全市场少的时候，说明有停牌/新股，页面要说明 */
  universe: number;
  /** 可选的日期清单，升序，给页面的下拉用 */
  dates: string[];
};

const ATTRIBUTE_LABEL = new RegExp(
  [
    "昨日",
    "今日",
    "最近",
    "新高",
    "新低",
    "涨停",
    "连板",
    "炸板",
    "触板",
    "融资融券",
    "深股通",
    "沪股通",
    "港股通",
    "MSCI",
    "富时",
    "标普",
    "转债",
    "基金",
    "重仓",
    "证金",
    "汇金",
    "社保",
    "QFII",
    "险资",
    "北向",
    "预盈",
    "预增",
    "减",
    "业绩",
    "扭亏",
    "亏损",
    "破净",
    "解禁",
    "质押",
    "回购",
    "员工持股",
    "股权激励",
    "举牌",
    "送转",
    "摘帽",
    "退市",
    "ST",
    "次新",
    "低价",
    "百元",
    "小盘",
    "大盘",
    "中盘",
    "成长",
    "价值",
    "风格",
    "分红",
    "股息",
    "国改",
    "央企",
    "国企",
    "专精特新",
    "科创板",
    "创业板",
    "中报",
    "年报",
    "季报",
    "预告",
    "预披露",
    "快报",
    "沪深300",
    "上证50",
    "中证",
    "深证",
    "AH股",
    "GDR",
    "B股",
  ].join("|"),
);

export const getInterval = createServerFn({ method: "GET" })
  .validator((input: unknown): { from: string; to: string } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const ok = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    return { from: ok(v.from) ? (v.from as string) : "", to: ok(v.to) ? (v.to as string) : "" };
  })
  .handler(async ({ data }): Promise<IntervalPayload | null> => {
    const { readFile } = await import("node:fs/promises");
    const dir = "data/history/closes";
    try {
      const meta = JSON.parse(await readFile(`${dir}/dates.json`, "utf8")) as { dates: string[] };
      const dates = meta.dates;
      const to = dates.includes(data.to) ? data.to : dates[dates.length - 1];
      const from = dates.includes(data.from) ? data.from : dates[Math.max(0, dates.length - 21)];
      if (!from || !to || from >= to) return null;

      const [fromMap, toMap, names] = await Promise.all([
        JSON.parse(await readFile(`${dir}/${from}.json`, "utf8")) as Record<string, number>,
        JSON.parse(await readFile(`${dir}/${to}.json`, "utf8")) as Record<string, number>,
        JSON.parse(await readFile(`${dir}/names.json`, "utf8")) as Record<string, string>,
      ]);

      const sessions = dates.filter((d) => d >= from && d <= to).length;
      const stocks: IntervalStock[] = [];
      for (const [id, a] of Object.entries(fromMap)) {
        const b = toMap[id];
        if (!b || !a || a <= 0) continue;
        stocks.push({ id, name: names[id] ?? id, from: a, to: b, chg: b / a - 1 });
      }
      stocks.sort((x, y) => y.chg - x.chg);

      // 板块：只看中位数，不看均值——一只 300% 的票能把板块均值拉飞
      let boards: IntervalBoard[] = [];
      try {
        const concepts = JSON.parse(await readFile("data/backtest/concepts.json", "utf8")) as {
          boards: { name: string; members: string[] }[];
        };
        const byId = new Map(stocks.map((s) => [s.id, s]));
        boards = concepts.boards
          .filter((b) => !ATTRIBUTE_LABEL.test(b.name) && b.members.length >= 8)
          .map((b) => {
            const hit = b.members.map((m) => byId.get(m)).filter((x): x is IntervalStock => Boolean(x));
            if (hit.length < 8) return null;
            const sorted = hit.map((h) => h.chg).sort((p, q) => p - q);
            const median = sorted[Math.floor(sorted.length / 2)];
            return {
              name: b.name,
              members: b.members.length,
              covered: hit.length,
              median,
              top: hit.slice().sort((p, q) => q.chg - p.chg)[0]?.name ?? "",
            };
          })
          .filter((x): x is IntervalBoard => Boolean(x))
          .sort((a, b) => b.median - a.median);
      } catch {
        boards = [];
      }

      return {
        from,
        to,
        sessions,
        covered: stocks.length,
        universe: Object.keys(toMap).length,
        dates,
        stocks: stocks.slice(0, 200).concat(stocks.slice(-50).reverse()),
        boards,
      };
    } catch {
      return null;
    }
  });
