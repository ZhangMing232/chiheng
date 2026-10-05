/**
 * 这个文件是干什么的：
 * 把扁平的成交列表按「交易日期」分组，算出每天开仓几笔、合计多少数量和金额、
 * 赚了还是亏了。持仓页按这个分组渲染。
 *
 * 你需要知道的：
 * 口径上有三件事必须说清，否则那个「金额」会被人当真钱：
 *
 * 1. **不记仓位大小。** 这套是模拟盘，每笔成交都当成满仓记（page-posters、README
 *    都这么写的）。所以「合计金额」只能给**名义金额**：每笔按一手（100 股）折算。
 *    它不是投入的钱，也无法据此算真实仓位。
 * 2. **收益率一律扣费**（`netReturn`，含买卖各千0.25%佣金 + 千0.5%印花税 + 规费）。
 *    汇总的收益率是**每笔收益率相加**，不是按金额加权——因为没有真实仓位可加权。
 *    这个口径在「累计收益」上一直这么用，别的地方也在用。
 * 3. **已实现和浮动分开算。** 卖出的用成交价算「已实现」，还拿着的用现价算「浮动」。
 *    两者相加才是那天到目前为止的盈亏；现价拿不到时浮动算不出来，那天就只有已实现。
 *
 * 这个文件只做计算，不碰 React，所以能自动测。
 */

import { netReturn } from "@/lib/market/journal-book";

/** 一手是 100 股。「数量」按这个折算，见上面的口径说明。 */
export const SHARES_PER_LOT = 100;

/** 一笔成交，配上它属于哪一天、现在的价、以及算出来的收益率。 */
export type PositionRow = {
  id: string;
  code: string;
  name: string;
  style?: string;
  /** 买入价 */
  entry: number;
  stop?: number;
  target?: number;
  /** 卖出价，没卖是 null */
  exit: number | null;
  exitDate: string | null;
  /** 建仓那天，YYYY-MM-DD */
  day: string;
  /** 当天记下来的时刻，比如 "09:41"。收盘后补记的那天靠它判断能不能算成绩。 */
  signalTime: string;
  /** 现价，持仓中才有。chg 允许为 null——行情源没给涨幅时就是这个状态 */
  live: { price: number; chg: number | null } | null;
  /** 收益率：已卖的是扣费后的实际收益；还拿着的是按现价算的浮动 */
  ret: number | null;
  /** 这笔的状态，由界面决定显示什么字 */
  state: string;
  /** 已实现盈亏的金额（按一手折算）；浮动时为 null */
  pnl: number | null;
  /**
   * 同期沪深300 的涨跌，用来算「有没有跑赢指数」。
   * 来自建仓当天的 indexEntry / indexExit，账本里没有就 null。
   */
  indexRet: number | null;
};

/** 一个交易日的汇总。 */
export type DayGroup = {
  date: string;
  /** 当天开仓笔数 */
  count: number;
  /** 合计数量（笔数 × 100 股） */
  shares: number;
  /** 合计名义金额 = Σ 买入价 × 100 */
  amount: number;
  /** 还没卖的 */
  open: PositionRow[];
  /** 已经卖掉的 */
  closed: PositionRow[];
  /** 已实现收益率之和，null = 当天没有一笔卖出 */
  realized: number | null;
  /** 浮动收益率之和，null = 当天没持仓或拿不到现价 */
  unrealized: number | null;
  /** realized + unrealized，任一为 null 就是 null */
  total: number | null;
  /** 已实现盈亏金额（按一手折算） */
  pnlAmount: number | null;
  /** 浮动盈亏金额（按一手折算） */
  openPnlAmount: number | null;
};

const money = (value: number | null): number | null => (value == null ? null : Math.round(value * 100) / 100);

/**
 * 按建仓日分组，最近的一天排在最前面。
 *
 * 入参不需要预先排序——这里会排。同一天内部的顺序保持传入顺序（通常是按分数排的），
 * 这样「今天买入的顺序」和选股表对得上。
 */
export function groupByDay(rows: PositionRow[]): DayGroup[] {
  const buckets = new Map<string, PositionRow[]>();
  for (const row of rows) {
    const list = buckets.get(row.day);
    if (list) list.push(row);
    else buckets.set(row.day, [row]);
  }
  const groups: DayGroup[] = [];
  for (const [date, items] of buckets) {
    const open = items.filter((row) => row.exit == null);
    const closed = items.filter((row) => row.exit != null);
    const realizedList = closed.map((row) => row.ret).filter((v): v is number => v != null);
    const openList = open.map((row) => row.ret).filter((v): v is number => v != null);
    const realized = realizedList.length > 0 ? realizedList.reduce((a, b) => a + b, 0) : null;
    // 只要这天有一笔持仓拿不到现价，这天的浮动盈亏就算不出来——宁可空着，
    // 也不能只按能算的那几笔凑一个数，那会让人以为全平了。
    const unrealized = open.length > 0 && openList.length === open.length
      ? openList.reduce((a, b) => a + b, 0)
      : null;
    groups.push({
      date,
      count: items.length,
      shares: items.length * SHARES_PER_LOT,
      amount: items.reduce((sum, row) => sum + row.entry * SHARES_PER_LOT, 0),
      open,
      closed,
      realized,
      unrealized,
      total: realized == null && unrealized == null ? null : (realized ?? 0) + (unrealized ?? 0),
      pnlAmount:
        closed.length > 0
          ? money(closed.reduce((sum, row) => sum + (row.pnl ?? 0) * SHARES_PER_LOT, 0))
          : null,
      openPnlAmount:
        open.length > 0 && openList.length === open.length
          ? money(open.reduce((sum, row) => sum + (row.pnl ?? 0) * SHARES_PER_LOT, 0))
          : null,
    });
  }
  return groups.sort((a, b) => b.date.localeCompare(a.date));
}

/** 所有天的合计，用来在页头放一行总览。 */
export type Overall = {
  count: number;
  shares: number;
  amount: number;
  openCount: number;
  closedCount: number;
  realized: number | null;
  unrealized: number | null;
  total: number | null;
};

export function overallOf(groups: DayGroup[]): Overall {
  const flat = groups.flatMap((group) => [...group.closed, ...group.open]);
  const closed = flat.filter((row) => row.exit != null);
  const open = flat.filter((row) => row.exit == null);
  const realizedList = closed.map((row) => row.ret).filter((v): v is number => v != null);
  const openList = open.map((row) => row.ret).filter((v): v is number => v != null);
  const realized = realizedList.length > 0 ? realizedList.reduce((a, b) => a + b, 0) : null;
  const unrealized = open.length > 0 && openList.length === open.length
    ? openList.reduce((a, b) => a + b, 0)
    : null;
  return {
    count: flat.length,
    shares: flat.length * SHARES_PER_LOT,
    amount: flat.reduce((sum, row) => sum + row.entry * SHARES_PER_LOT, 0),
    openCount: open.length,
    closedCount: closed.length,
    realized,
    unrealized,
    total: realized == null && unrealized == null ? null : (realized ?? 0) + (unrealized ?? 0),
  };
}

/** 「10月5日 周一」这种标题。weekday 由调用方传，缺了就不带星期。 */
export function dayHeading(date: string, weekday?: string): string {
  const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return date;
  const base = `${Number(match[2])}月${Number(match[3])}日`;
  return weekday ? `${base} ${weekday}` : base;
}

/** 由一笔成交算出收益率。已卖的扣费，持有的按现价。 */
export function rowReturn(
  entry: number,
  exit: number | null,
  livePrice: number | null,
): number | null {
  if (exit != null) return netReturn(entry, exit);
  if (livePrice == null || !(livePrice > 0)) return null;
  return livePrice / entry - 1;
}

/**
 * 紧迫度分级——盘中第 ② 步（看谁到止损/目标价了）是最高频动作，
 * 排序必须服务于它。
 *
 * 你需要知道的：
 * 原先持仓按建仓日排、组内按传入顺序排，等于要自己在一屏 60 行里找那几只
 * 到价的。现在按「能不能现在动手」排：能动手的排最前，不能动手的（T+1、跌停）
 * 次之，剩下按收益率从低到高——盯盘时先看亏得最多的。
 *
 * 纯函数，放这儿是为了能自动测：这个顺序错了不会崩，但会让盯盘时多花几秒，
 * 而那几秒是最贵的。
 */

/** 数字越小越紧急。 */
export const URGENCY = {
  /** 到了止损价，能卖，该马上处理 */
  stop: 0,
  /** 到了目标价，能卖，该马上处理 */
  target: 1,
  /** 跌停，卖不出。紧急但动不了——要让人看见，别让人以为漏了 */
  limitDown: 2,
  /** 当天买的，不能卖 */
  t1: 3,
  /** 正常持有 */
  hold: 4,
  /** 已经卖掉的 */
  closed: 5,
} as const;

export type UrgencyLevel = (typeof URGENCY)[keyof typeof URGENCY];

/** 这一笔现在处于什么紧迫度。认不出来就当正常持有，不要猜。 */
export function urgencyOf(row: Pick<PositionRow, "state" | "exit">): UrgencyLevel {
  if (row.exit != null) return URGENCY.closed;
  if (row.state === "止损") return URGENCY.stop;
  if (row.state === "卖出") return URGENCY.target;
  if (row.state === "跌停") return URGENCY.limitDown;
  if (row.state === "T+1") return URGENCY.t1;
  return URGENCY.hold;
}

/** 需要「现在处理」的那些：到了价能卖的，加上跌停卖不出的（要看见）。 */
export function needsAction(row: PositionRow): boolean {
  const level = urgencyOf(row);
  return level === URGENCY.stop || level === URGENCY.target || level === URGENCY.limitDown;
}

/**
 * 按紧迫度排序。同一档内按收益率从低到高（亏得多的排前面）。
 *
 * 稳定排序：原来顺序相同的不打乱，所以「同一只票在不同分组里」位置不会乱跳。
 */
export function sortByUrgency(rows: PositionRow[]): PositionRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const d = urgencyOf(a.row) - urgencyOf(b.row);
      if (d !== 0) return d;
      const ra = a.row.ret ?? Number.POSITIVE_INFINITY;
      const rb = b.row.ret ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((item) => item.row);
}
