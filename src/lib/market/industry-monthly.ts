/**
 * 这个文件是干什么的：
 * 把行业板块的**日线 + 资金流**聚合成月度（D5），就是产业链 SOP 的「产业温度计」原料。
 *
 * **为什么不是价格/库存/capex**：2026-10-13 探过源。原目标（分行业的价格、库存、
 * 资本开支——DRAM 报价、水泥价格那类）在免费源里拿不到：国家统计局被 WAF 挡
 * （403 UrlACL），行业协会数据要么付费要么得爬。能稳定免费拿到的是东财行业板块
 * 的日线（实测 4071 天）和日级资金流，所以温度计改成「月度涨跌幅 + 月度主力净流入
 * + 月度换手」。**这是量价与资金维度的温度计，不是供需维度的**，读的时候别把它
 * 说成「行业景气度」——它只能说明资金和价格在往哪走。
 *
 * 口径（改之前先看这几条，都是踩过或会踩的坑）：
 * 1. **月度涨跌幅用上月最后收盘做基准**，不用月内首日开盘。用首日开盘会把节假日
 *    跳空吃掉，等于凭空少算一段涨跌。
 * 2. **资金流缺失的月份填 null，不填 0**。0 会被读成「这个月资金持平」，
 *    其实是没数据。
 * 3. **月内交易日太少要标 partial**。只有 1–2 个交易日的月份（春节那类），
 *    拿它当整月看会得出荒唐结论。
 * 4. **当月还没走完也是 partial**，最后一个月的数字每天在变，不能当既成事实。
 * 5. 只描述过去，不预测，不给买卖暗示（和事件研究同一条纪律）。
 */

/** 板块日线一根。 */
export type BoardDaily = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交额（元） */
  amount: number;
  /** 换手率（%） */
  turnover: number;
};

/** 板块日级资金流一根。mainNet 是主力净流入净额（元），负数是流出。 */
export type BoardFlow = { date: string; mainNet: number };

export type IndustryMonth = {
  /** YYYY-MM */
  month: string;
  firstDay: string;
  lastDay: string;
  /** 月内交易日数 */
  sessions: number;
  /** 月末收盘 */
  close: number;
  /** 相对上月月末收盘的涨跌（%）。第一个月没有上月基准 → null */
  chgPct: number | null;
  /** 主力净流入合计（元）。缺资金流 → null */
  mainNet: number | null;
  /** 月均换手（%）。缺换手 → null */
  avgTurnover: number | null;
  /** 月内振幅（%）：(最高 − 最低) / 月初基准 */
  amplitudePct: number | null;
  /** 月内交易日太少，或当月还没走完 */
  partial: boolean;
};

export type MonthlyResult = {
  months: IndustryMonth[];
  gaps: string[];
};

export const MIN_SESSIONS = 15;

const monthKey = (date: string) => date.slice(0, 7);

/**
 * 日线（+ 可选资金流）→ 月度。
 * bars 必须按日期升序；资金流按日期匹配，对不上的那天不算（不猜）。
 */
export function monthlyFromBars(bars: readonly BoardDaily[], flow: readonly BoardFlow[] = [], today?: string): MonthlyResult {
  const gaps: string[] = [];
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return { months: [], gaps: ["没有日线数据"] };

  const flowByDate = new Map<string, number>();
  for (const row of flow) if (!flowByDate.has(row.date)) flowByDate.set(row.date, row.mainNet);

  const groups = new Map<string, BoardDaily[]>();
  for (const bar of sorted) {
    const key = monthKey(bar.date);
    const list = groups.get(key) ?? [];
    list.push(bar);
    groups.set(key, list);
  }

  const months: IndustryMonth[] = [];
  let prevClose: number | null = null;
  for (const [month, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const last = list[list.length - 1]!;
    const close = last.close;
    const base = prevClose ?? list[0]!.open;
    const high = Math.max(...list.map((b) => b.high));
    const low = Math.min(...list.map((b) => b.low));
    const nets: number[] = [];
    const turnovers: number[] = [];
    for (const bar of list) {
      const net = flowByDate.get(bar.date);
      if (net != null && Number.isFinite(net)) nets.push(net);
      if (Number.isFinite(bar.turnover) && bar.turnover > 0) turnovers.push(bar.turnover);
    }
    // 当月没走完：日期跨到今天所在月之后才算完整月
    const incomplete = today != null ? month >= monthKey(today) : false;
    const partial = incomplete || list.length < MIN_SESSIONS;
    if (list.length < MIN_SESSIONS) gaps.push(`${month} 只有 ${list.length} 个交易日，标 partial`);
    months.push({
      month,
      firstDay: list[0]!.date,
      lastDay: last.date,
      sessions: list.length,
      close,
      chgPct: prevClose != null && prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : null,
      mainNet: nets.length > 0 ? nets.reduce((a, b) => a + b, 0) : null,
      avgTurnover: turnovers.length > 0 ? turnovers.reduce((a, b) => a + b, 0) / turnovers.length : null,
      amplitudePct: base > 0 ? ((high - low) / base) * 100 : null,
      partial,
    });
    prevClose = close;
  }
  return { months, gaps };
}

/** 只取完整月（去掉 partial 的），用于下结论。 */
export function completeMonths(months: readonly IndustryMonth[]): IndustryMonth[] {
  return months.filter((m) => !m.partial);
}

/** 最近 n 个完整月。不足 n 个就少给几个（不补、不编）。 */
export function recentMonths(months: readonly IndustryMonth[], n: number): IndustryMonth[] {
  return completeMonths(months).slice(-n);
}

/**
 * 温度计的读法：最近 n 个完整月里，价格与主力资金**是否同向**。
 * 只说方向，不说「景气」——量价资金维度的东西撑不起景气度这个词。
 */
export function thermometer(months: readonly IndustryMonth[], n = 3): Thermometer {
  const recent = recentMonths(months, n);
  if (recent.length === 0) return { direction: "不明", basis: "没有完整月份", months: [] };
  const ups = recent.filter((m) => (m.chgPct ?? 0) > 0).length;
  const downs = recent.filter((m) => (m.chgPct ?? 0) < 0).length;
  const nets = recent.map((m) => m.mainNet).filter((v): v is number => v != null);
  const netUp = nets.filter((v) => v > 0).length;
  const netDown = nets.filter((v) => v < 0).length;
  const priceUp = ups > downs;
  const priceDown = downs > ups;
  const moneyUp = nets.length > 0 && netUp > netDown;
  const moneyDown = nets.length > 0 && netDown > netUp;
  const basis = [
    `${recent.length} 个完整月：月涨 ${ups} / 月跌 ${downs}`,
    nets.length > 0 ? `主力净流入月 ${netUp} / 净流出月 ${netDown}` : "资金流缺失",
  ].join("；");
  let direction: ThermometerDirection = "不明";
  if (priceUp && moneyUp) direction = "升温";
  else if (priceDown && moneyDown) direction = "降温";
  else if (priceUp && moneyDown) direction = "背离";
  else if (priceDown && moneyUp) direction = "背离";
  return { direction, basis, months: recent.map((m) => m.month) };
}

export type ThermometerDirection = "升温" | "降温" | "背离" | "不明";
export type Thermometer = { direction: ThermometerDirection; basis: string; months: string[] };

// ── 东财返回体解析（放在这儿是为了能写单测，脚本只负责拉） ──────────────

type KlinePayload = { data?: { klines?: string[] } };

const numAt = (parts: string[], i: number): number => {
  const v = Number(parts[i]);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * 板块日线（push2his kline，fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61）。
 * 顺序：日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
 */
export function parseBoardDaily(payload: unknown): BoardDaily[] {
  const rows = (payload as KlinePayload | null)?.data?.klines;
  if (!Array.isArray(rows)) return [];
  const out: BoardDaily[] = [];
  for (const line of rows) {
    const parts = String(line).split(",");
    if (parts.length < 11) continue;
    const date = parts[0] ?? "";
    const close = numAt(parts, 2);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    out.push({
      date,
      open: numAt(parts, 1),
      close,
      high: numAt(parts, 3),
      low: numAt(parts, 4),
      amount: numAt(parts, 6),
      turnover: numAt(parts, 10),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 板块资金流（push2his fflow，fields2=f51,f52,...）。
 * 顺序：日期,主力净流入,小单,中单,大单,超大单,主力净占比…
 */
export function parseBoardFlow(payload: unknown): BoardFlow[] {
  const rows = (payload as KlinePayload | null)?.data?.klines;
  if (!Array.isArray(rows)) return [];
  const out: BoardFlow[] = [];
  for (const line of rows) {
    const parts = String(line).split(",");
    if (parts.length < 2) continue;
    const date = parts[0] ?? "";
    const mainNet = numAt(parts, 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(mainNet)) continue;
    out.push({ date, mainNet });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
