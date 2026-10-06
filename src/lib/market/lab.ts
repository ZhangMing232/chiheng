/**
 * 这个文件是干什么的：
 * 把账本算成一句人话——「这套规则现在能不能下结论，还差什么」。
 * 页面上那块「策略实验台」的全部数字都从这里出，UI 不自己算任何一笔。
 *
 * 你需要知道的（三条，都是踩过坑才定下来的）：
 *
 * 1. **还没卖出的那一笔，收益率必须是 null，不能是 0。**
 *    0 会读成「不赚不亏」，而它真正的意思是没有答案。账上还拿着几十笔没走到
 *    卖出日的票，拿它们当 0 去算平均，等于凭空往样本里塞几十个中性样本，
 *    胜率和均值都会被拉平、看起来像「稳稳的」，其实是没测。
 *    样本墙也是这个规矩：能着色的是已结的 11 格，剩下 60 格空心。
 *
 * 2. **「能不能下结论」只看已结样本，不看在拿的。**
 *    在拿的票还没走到卖出日，它们的结果未知；拿浮动盈亏提前宣布胜负，
 *    就是回测里那件事的线上版：用没兑现的部分冒充成绩。
 *
 * 3. **指数对照拿不到，要显式说出来，不能只留一个空数字。**
 *    账本的 indexExit 是建仓当天的沪深300 对照价，卖出时要再更新一次。
 *    现在两天都是 null（缺了 indexExit），所以「跑赢没」这个问题
 *    从记录那天起就答不了——这是实验设计本身的缺口，不是数据丢了。
 *    所以 benchmark.missingDays 要给出来，让界面能直接写「同期沪深300 拿不到」。
 *
 * 口径另有两条沿用别处的老规矩：
 *   - 收益率一律扣费（netReturn，含买卖佣金 + 印花税 + 规费），不另起一套。
 *   - 收盘后补记的那天（signalTime ≥ 15:00）不进统计，沿用 dayReliable 的判断。
 *
 * 第二条有个**会让人以为账本没数据**的后果，必须专门处理：它是一整天地排掉，
 * 而那一天的成交里可能已经有卖出的、真金白银结算过的。所以报告里要把
 * `skipped` 带出去，界面上明写「有 N 个交易日（M 笔）是收盘后补记的，按口径不进样本」。
 * 不写这句话，用户会看到样本墙 42 格全是空心、而持仓页上明明摆着 11 笔已卖的
 * 盈亏，两处对不上就会去怀疑哪边算错了——其实两边都对，只是口径不同。
 */

import type { PaperDay, PaperTrade } from "@/lib/paper";
import { dayReliable, netReturn } from "./journal-book.ts";
import { ACTIVE_STYLES, STYLES } from "./strategies.ts";

/**
 * 一套策略要单独说话，需要多少笔已结样本。
 *
 * 这是**设计上定的数，不是回测算出来的**。定它的理由：30 笔大致能让
 * 「平均收益 ±3%」这个量级的估计稳定到不用天天改口； fewer 的时候
 * 今天正明天负，界面写什么都是在抖。真正的止损/止盈门槛在 rules.minClosed
 * 里（现在是 20），那个是回测推出来的，两个数不要求一致，
 * 但界面必须说清这个 30 是「每套策略各自的门槛」。
 *
 * 别把这个数当成算法结论去改。要改得先重跑回测。
 */
export const PER_STYLE_GOAL = 30;

/** 样本墙上的一格。已结的按盈亏着色，在拿的是空心的。 */
export type LabCell = {
  style: string;
  name: string;
  /** 已结的收益率；在拿的是 null（没有答案，不是 0） */
  ret: number | null;
  open: boolean;
};

/** 一套策略的样本情况。 */
export type LabStyleRow = {
  style: string;
  name: string;
  /** 这套一共开了几笔（含还在拿的） */
  total: number;
  /** 已经卖掉了几笔 */
  closed: number;
  /** 还在拿几笔 */
  open: number;
  /** 卖出的里赚了几笔；一笔都没卖是 null */
  win: number | null;
  /** 卖出的平均收益；一笔都没卖是 null */
  avg: number | null;
  /** 这套要单独说话需要的已结笔数 */
  goal: number;
  /** 离这套自己的门槛还差几笔。已下线的是 0——不会再有新样本，这个数永远填不满 */
  needMore: number;
  /**
   * 这套已经不再自动建仓（不在 ACTIVE_STYLES 里）。
   * 界面对它显示「已下线」而不是「还差 N 笔」：让人一直等一个不会来的数，
   * 比直接告诉他这套停了更让人困惑。
   */
  retired: boolean;
};

/** 指数对照能不能比。 */
export type LabBenchmark = {
  /** 至少有一天的 indexEntry 和 indexExit 都存下了，能算出对比 */
  available: boolean;
  /** 记下了 indexEntry 却没 indexExit 的交易日数。>0 就是「有几天的对照价缺着」 */
  missingDays: number;
};

/** 实验台的全套报告。 */
export type LabReport = {
  /** 有多少个交易日进了统计 */
  days: number;
  /** 一共开了几笔 */
  total: number;
  closed: number;
  open: number;
  /** 整套能不能下结论的门槛（rules.minClosed） */
  goal: number;
  /** 还差几笔才到整套门槛 */
  needMore: number;
  /** 进度百分比，上限 100。不到门槛就只是进度，不是结论 */
  progress: number;
  /**
   * 被 dayReliable 排掉的那部分。整天排掉，所以里头可能已经有卖出结算的。
   * 界面要把它写出来，否则样本墙和持仓页会对不上账。
   */
  skipped: { days: number; trades: number };
  /** 现在能不能下结论 */
  canSay: boolean;
  /** 为什么还不能说（canSay 为 true 时是空的） */
  reason: string;
  /** 样本墙的格子，按开仓时间从早到晚 */
  cells: LabCell[];
  byStyle: LabStyleRow[];
  benchmark: LabBenchmark;
};

const STYLE_NAMES = new Map<string, string>(STYLES.map((item) => [item.id, item.name]));

/** 策略 id 找不到对应中文名时退回 id 本身，不显示空。 */
export function styleName(style: string | undefined): string {
  if (!style) return "未标注策略";
  return STYLE_NAMES.get(style) ?? style;
}

function styleOrder(): string[] {
  return STYLES.map((item) => item.id);
}

/** 把某一天里的几笔摊平，带出收益率。收盘后补记的那天整跳过。 */
function flatten(day: PaperDay): { trade: PaperTrade; ret: number | null; open: boolean }[] {
  if (!dayReliable(day)) return [];
  return day.trades.map((trade) => {
    if (trade.exit != null) return { trade, ret: netReturn(trade.entry, trade.exit), open: false };
    // 还没卖：没有答案，ret 就是 null。别拿 0 顶。
    return { trade, ret: null, open: true };
  });
}

/**
 * 账本 → 实验台报告。
 *
 * days 不要求排序，这里会按日期从早到晚排（样本墙要按时间铺开）。
 * rules.minClosed 传 0 表示整块结论区被关掉（界面据此整块不显示）。
 */
export function buildLabReport(days: PaperDay[], rules: { minClosed: number }): LabReport {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));

  const cells: LabCell[] = [];
  const rows: { style: string; name: string; ret: number | null; open: boolean }[] = [];
  let countedDays = 0;
  let missingDays = 0;
  let comparableDays = 0;
  let skippedDays = 0;
  let skippedTrades = 0;

  for (const day of ordered) {
    // 收盘后补记的整天排掉。先记下排了多少，交给界面说清楚，别让样本凭空少一截。
    if (!dayReliable(day)) {
      skippedDays += 1;
      skippedTrades += day.trades.length;
      continue;
    }
    const flat = flatten(day);
    if (flat.length === 0) continue;
    countedDays += 1;
    // indexEntry 是建仓那天的指数，indexExit 是卖出那天更新的。
    // 先有 entry 才有 Exit 可言；两天都有的那天才真能比。
    if (day.indexEntry != null && day.indexExit != null) comparableDays += 1;
    else if (day.indexEntry != null) missingDays += 1;
    for (const item of flat) {
      const name = styleName(item.trade.style);
      cells.push({ style: item.trade.style ?? "", name, ret: item.ret, open: item.open });
      rows.push({ style: item.trade.style ?? "", name, ret: item.ret, open: item.open });
    }
  }

  const closed = rows.filter((row) => !row.open);
  const open = rows.length - closed.length;
  const goal = rules.minClosed > 0 ? rules.minClosed : 0;
  const needMore = goal > 0 ? Math.max(0, goal - closed.length) : 0;
  const progress = goal > 0 ? Math.min(100, (closed.length / goal) * 100) : 0;

  const known = styleOrder();
  const extra = [...new Set(rows.map((row) => row.style))].filter((style) => !known.includes(style));
  const byStyle: LabStyleRow[] = known
    .concat(extra)
    .map((style) => {
      const mine = rows.filter((row) => row.style === style);
      const mineClosed = mine.filter((row) => !row.open);
      const rets = mineClosed.map((row) => row.ret).filter((v): v is number => v != null);
      // 已下线的策略不会再有新样本，所以「离 30 笔还差 N 笔」是个永远填不满的
      // 数字。标出来，让界面显示成「已下线」而不是让人一直等一个不会来的数。
      const retired = !ACTIVE_STYLES.includes(style as (typeof ACTIVE_STYLES)[number]);
      return {
        style,
        name: styleName(style),
        retired,
        total: mine.length,
        closed: mineClosed.length,
        open: mine.length - mineClosed.length,
        win: rets.length > 0 ? rets.filter((value) => value > 0).length : null,
        avg: rets.length > 0 ? rets.reduce((sum, value) => sum + value, 0) / rets.length : null,
        goal: PER_STYLE_GOAL,
        needMore: retired ? 0 : Math.max(0, PER_STYLE_GOAL - mineClosed.length),
      };
    })
    .filter((row) => row.total > 0)
    // 样本多的排前面。平手时按名字排，顺序稳定，界面不会今天一个样明天一个样。
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const canSay = goal > 0 && closed.length >= goal && comparableDays > 0;
  const reason = !canSay
    ? goal === 0
      ? "结论门槛被关掉了，页面只报样本进度，不下判断"
      : closed.length < goal
        ? `能对比指数的已结样本 ${closed.length}/${goal}，还差 ${Math.max(0, goal - closed.length)} 笔`
        : "已结样本够了，但账本里没有一天的沪深300 对照价，扣掉指数这个维度还没法比"
    : "";

  return {
    days: countedDays,
    total: rows.length,
    closed: closed.length,
    open,
    goal,
    needMore,
    progress,
    skipped: { days: skippedDays, trades: skippedTrades },
    canSay,
    reason,
    cells,
    byStyle,
    benchmark: { available: comparableDays > 0, missingDays },
  };
}
