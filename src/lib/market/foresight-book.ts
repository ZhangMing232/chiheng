/**
 * 这个文件是干什么的：
 * 把「前瞻回验」的落档 picks 转成账本买入计划（纯函数，零 IO，直接单测）。
 *
 * 为什么要有它（2026-11-16 用户拍板）：
 * 前瞻回验原先只在自己那一套里算收益（outcomes 里的 tradePct/holdPct），
 * **不进模拟盘账本**——用户看 today 页显示「成交」却在账本里找不到那只票，
 * 问「不然怎么知道收益怎么样」。这条链路补齐：前瞻挑的票也真正买入记账。
 *
 * 关键设计（避免污染现有统计）：
 * 1. **style 用 "relay"**（短线，hold=1），因为 StyleId 是封闭枚举、加新值会
 *    牵连 styleOf 过滤/策略闸/页面分桶；relay 语义最接近（打板短线、次日出）。
 * 2. **variant 固定 "foresight"**：账本里靠 variant 分桶，冠军/挑战者/前瞻三套
 *    互不干扰，判决和净值各算各的。
 * 3. 入场价 = 当日**开盘价**（前瞻规则的买入时点就是次日开盘），不是收盘价——
 *    这是它和 value 等策略的本质差别。开盘涨停不等于买不进：只要盘中有开板
 *    （最低价 < 涨停价），开盘那一刻就有卖单、涨停价能成交（11-17 实测 5 笔都如此）；
 *    只有**一字板**（开盘=涨停=全天最低）才真排不进——那种一律不买（2026-11-17 补）。
 */

/** 前瞻落档的一只 pick（只取买入需要的字段）。 */
export type ForecastPick = {
  code: string;
  name: string;
  /** 选股日收盘价，用来在拿不到开盘价时兜底（并标记出来）。 */
  pickPrice: number | null;
};

/** 一条待写入账本的买入计划。 */
export type ForesightBuy = {
  id: string;
  code: string;
  name: string;
  /** 入场价：当日开盘价；开盘价拿不到时用 pickPrice 兜底并降级标记。 */
  entry: number;
  stop: number | null;
  target: number | null;
  style: "relay";
  variant: "foresight";
  hold: number;
  /** 买入说明（开板/一字板判定），写入日志可追溯。 */
  note: string | null;
};

/** 前瞻腿专用常量：短线 1 天出（和 relay 的 STYLE_HOLD 一致）。 */
export const FORESIGHT_HOLD = 1;
/** 前瞻腿的止损/目标幅度（%）：打板短线，止损 5%、目标 10%。 */
export const FORESIGHT_STOP_PCT = 5;
export const FORESIGHT_TARGET_PCT = 10;

/** 买入日的完整 K 线（判一字板用）+ 昨收（算涨停价）。 */
export type BuyDayBar = {
  o: number; h: number; l: number; c: number;
  /** 买入日前一交易日的收盘价，算涨停价用。拿不到就返回 null，不猜。 */
  prevClose: number | null;
};

/**
 * 定可成交的买入价（纯函数）。
 * - 一字涨停（开盘=涨停=全天最低）→ null：挂单排不进，不记假成交。
 * - 开盘涨停但盘中开板（最低 < 涨停）→ 按开盘价买（那一刻能成交）。
 * - 正常开盘 → 按开盘价买。
 * 涨停价用昨收×(1+limitPct)，limitPct 由调用方传入（boardLimit，纯函数）。
 */
export function fillPriceOf(bar: BuyDayBar, limitPct: number): { entry: number; note: string | null } | null {
  if (!(bar.o > 0)) return null;
  if (bar.prevClose == null || !(bar.prevClose > 0)) return { entry: bar.o, note: null };
  const up = Math.round(bar.prevClose * (1 + limitPct / 100) * 100) / 100;
  const eps = 0.005;
  if (bar.o >= up - eps && bar.l >= up - eps) {
    return null; // 一字板：全天最低都在涨停价，买不进
  }
  if (bar.o >= up - eps) {
    return { entry: bar.o, note: `开盘涨停后开板（最低 ${bar.l.toFixed(2)}），开盘价 ${bar.o.toFixed(2)} 能成交` };
  }
  return { entry: bar.o, note: null };
}

/**
 * 生成买入计划。
 * @param picks 落档 picks
 * @param bars 代码 → 当日完整 K 线（含昨收，判一字板用；拿不到传 null）
 * @param limitPctOf 代码 → 涨跌停百分比（boardLimit 纯函数）
 * @param alreadyHeld 账本里已持有（未卖出）的代码，防重复买入
 */
export function planForesightBuys(
  picks: ForecastPick[],
  bars: Map<string, BuyDayBar | null>,
  limitPctOf: (code: string) => number,
  alreadyHeld: Set<string>,
): ForesightBuy[] {
  const out: ForesightBuy[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    if (!p.code || seen.has(p.code) || alreadyHeld.has(p.code)) continue;
    const bar = bars.get(p.code) ?? null;
    // 拿不到买入日 K 线就跳过——不拿 pickPrice（选股日收盘）冒充买入价。
    if (!bar) continue;
    const fill = fillPriceOf(bar, limitPctOf(p.code));
    // 一字板买不进 → 不记假成交（2026-11-17 补）。
    if (!fill) continue;
    seen.add(p.code);
    out.push({
      id: p.code,
      code: p.code.replace(/^(sh|sz|bj)/i, ""),
      name: p.name,
      entry: fill.entry,
      stop: Math.round(fill.entry * (1 - FORESIGHT_STOP_PCT / 100) * 100) / 100,
      target: Math.round(fill.entry * (1 + FORESIGHT_TARGET_PCT / 100) * 100) / 100,
      style: "relay",
      variant: "foresight",
      hold: FORESIGHT_HOLD,
      note: fill.note,
    });
  }
  return out;
}

/** 判断一笔账本交易是不是前瞻腿（页面/统计分桶用）。 */
export function isForesightTrade(trade: { variant?: string | null }): boolean {
  return trade.variant === "foresight";
}

/** 账本里一笔 foresight 交易的展示口径（两套并存时用）。 */
export type BookForesight = {
  code: string;
  buyDay: string;
  entry: number;
  exit: number | null;
  exitDay: string | null;
  /** 已平仓的真实收益（含 ±5%/10% 风控），未平为 null。 */
  ret: number | null;
  reason: string | null;
  /** 买入说明（开板能成交等），老账没有为 null。 */
  note: string | null;
};

/**
 * 把账本 days[] 里的 foresight 交易索引成 (code@买入日) → 展示口径。
 * 同一只票同一天多笔取最后一笔（补买覆盖旧的，和账本追加顺序一致）。
 * 2026-11-17 加：/huiyan 要在同一张表里同时显示「规则验证收益」和
 * 「账本模拟收益」两套口径，各自标清，不再让两个数打架。
 */
export function indexBookForesight(
  days: { date: string; trades: { id?: string; code?: string; variant?: string | null; entry: number; exit?: number | null; exitDate?: string | null; note?: string | null }[] }[],
): Map<string, BookForesight> {
  const out = new Map<string, BookForesight>();
  for (const day of days) {
    for (const t of day.trades) {
      if (!isForesightTrade(t)) continue;
      const code = t.id ?? t.code ?? "";
      if (!code) continue;
      const exit = typeof t.exit === "number" ? t.exit : null;
      out.set(`${code}@${day.date}`, {
        code,
        buyDay: day.date,
        entry: t.entry,
        exit,
        exitDay: t.exitDate ?? null,
        ret: exit != null && t.entry > 0 ? exit / t.entry - 1 : null,
        reason: exit != null ? "账本模拟（±5%/10% 风控）" : "持仓中",
        note: (t as { note?: string | null }).note ?? null,
      });
    }
  }
  return out;
}


/**
 * 交易的策略显示名。foresight 腿虽然借用了 style=relay（避免扩封闭枚举），
 * 但它不是「次日补涨」——是「前瞻验证 · 当日收盘卖」，必须按真身显示，
 * 否则持仓页策略列会把前瞻票误标成次日补涨（2026-11-17 用户截图发现）。
 * 传 styleNameOf（STYLES 查表函数）进去，避免本模块依赖 UI 层。
 */
export function strategyLabelOf(
  trade: { variant?: string | null; style?: string },
  styleNameOf: (style: string) => string,
): string {
  if (isForesightTrade(trade)) return "前瞻验证";
  return styleNameOf((trade as { style?: string }).style ?? "");
}
