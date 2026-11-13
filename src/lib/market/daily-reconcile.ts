/**
 * 「今天说了什么」和「后来真买了什么」的对账（纯函数，零 IO、不取当前时间）。
 *
 * 为什么单独抽一层：/today 的名单来自 data/signals/reviewed.json（竞价审核后的信号），
 * 策略追踪的成交来自账本 data/books/*.json（记账进程自己扫 universe 后真正记下的）。
 * 两次扫描时点、过滤条件不同，产出本来就不一样 —— 2026-11-13 实测 20 只信号 /
 * 3 笔成交 / 只有 1 只重合。以前两页各说各的，用户看完前者去后者对不上号。
 * 这一层只做**展示对齐**，不改任何选股或建仓行为。
 *
 * 🔴 两条口径必须分开，不许互相冒充（用户立的 A 股成交铁律第 4 条）：
 * - `fillPrice` 是 getSignalReviewed 用当日日 K **事后重算的理论成交**，
 *   本模块刻意不接收它 —— 理论值永远进不了「账本成交价」。
 * - `entry` 是账本**当时记下的真实成交**，只有它能显示成「已买 XX.XX」。
 *
 * 纪律：读不到数据一律返回 missing 原因，不补 0、不拿空数组冒充「没买」。
 */

/** 信号侧一行：只挑对账与展示需要的字段，不把整份 reviewed 拖进页面。 */
export type ReconcileSignal = {
  code: string;
  name: string;
  /** long=中长线 / short=短线；旧文件没有这个字段就当未分腿。 */
  leg?: "long" | "short";
  /** 竞价审核后报给用户的下单价；null = 不追高、放弃。 */
  orderPrice: number | null;
  /** 理论成交状态，仅用于标注口径，绝不当成账本成交。 */
  fillStatus?: "filled" | "missed" | "pending";
  verdict?: "ok" | "warn" | "skip";
};

/** 账本侧一笔：只带展示需要的字段。 */
export type ReconcileTrade = {
  code: string;
  name: string;
  /** 账本当时记下的真实成交价。 */
  entry: number;
  style?: string;
  variant?: string | null;
  /** 挑战者深扫标记：和 variant 一起决定「实验田」归因。 */
  deepScan?: boolean | null;
  exit?: number | null;
};

export type ReconcileDay = { date: string; trades: ReconcileTrade[] };

/** 归一化成六位代码：前瞻 picks 的 code 带 sh/sz/bj 前缀，账本与信号都是六位。 */
export function sixDigitCode(raw: string | null | undefined): string {
  return (raw ?? "").replace(/^(sh|sz|bj)/i, "").trim();
}

export type SignalRow = {
  signal: ReconcileSignal;
  /** 匹配上的账本成交；没有就是 null（未买，或账本读不到 —— 看 missing）。 */
  bookTrade: ReconcileTrade | null;
};

export type ReconcileResult = {
  date: string;
  /** 每一只信号 + 它的账本状态，保持输入顺序。 */
  signalRows: SignalRow[];
  /** 两边都有的票（按票去重）。 */
  matched: ReconcileSignal[];
  /** /today 有、账本没买。 */
  signalOnly: ReconcileSignal[];
  /** 账本买了、/today 没提（按笔列，不去重）。 */
  bookOnly: ReconcileTrade[];
  /** 当天账本全部成交（精简字段），页面拿它建 Map 给任意一行查状态。 */
  bookTrades: ReconcileTrade[];
  /** 当天账本成交总笔数（含同一只多笔），直接取真值，不从分类反推。 */
  bookTradeCount: number;
  /** 数据读不到时写原因；此时「未买」不可信，页面必须显示原因。 */
  missing: string | null;
};

/**
 * 把某一天的信号名单与账本成交对齐。
 *
 * 关联键 = 六位 code + 当天日期；日期不匹配的一律不算重合。
 * 同一只当天多笔成交只算一次重合，但 bookOnly 会如实列出每一笔（不悄悄去重）。
 */
export function reconcileDay(args: {
  date: string;
  signals: ReconcileSignal[] | null;
  days: ReconcileDay[] | null;
  /** getServerJournal 的 why；有值就代表账本读不到。 */
  journalWhy?: string | null;
}): ReconcileResult {
  const { date, signals, days, journalWhy } = args;
  // 三种「读不到」各自写明原因；「读到了但当天没有记录」是真实的零成交，不算缺口。
  const journalUnavailable =
    journalWhy != null && journalWhy !== ""
      ? `账本读不到：${journalWhy}`
      : days == null
        ? "账本读不到：服务端没返回"
        : null;
  const missing =
    journalUnavailable ?? (signals == null ? "信号名单读不到：服务端没返回" : null);

  const sigList = signals ?? [];
  // 只认当天：账本按天分组，日期不匹配就不参与，避免拿昨天的成交冒充今天的。
  const day = days?.find((d) => d.date === date) ?? null;
  const trades = day?.trades ?? [];

  const byCode = new Map<string, ReconcileTrade>();
  for (const t of trades) {
    const key = sixDigitCode(t.code);
    if (key && !byCode.has(key)) byCode.set(key, t);
  }

  const signalRows: SignalRow[] = sigList.map((signal) => ({
    signal,
    bookTrade: byCode.get(sixDigitCode(signal.code)) ?? null,
  }));

  const matched = signalRows.filter((r) => r.bookTrade != null).map((r) => r.signal);
  const signalOnly = signalRows.filter((r) => r.bookTrade == null).map((r) => r.signal);

  const sigCodes = new Set(sigList.map((s) => sixDigitCode(s.code)));
  const bookOnly = trades.filter((t) => !sigCodes.has(sixDigitCode(t.code)));

  return {
    date,
    signalRows,
    matched,
    signalOnly,
    bookOnly,
    bookTrades: trades,
    bookTradeCount: trades.length,
    missing,
  };
}

/** 给页面用的一行汇总，数字都从结果里现算，不写死。 */
export function reconcileSummary(r: ReconcileResult): string {
  return `信号 ${r.signalRows.length} 只 · 账本成交 ${r.bookTradeCount} 笔 · 重合 ${r.matched.length} 只`;
}

/**
 * 「账本买了、/today 没提」的归因（P2 报告 §5-①）。
 *
 * 2026-11-13 对 5 个交易日 31 笔差异逐笔核过：没有一笔是丢单，全是这三类。
 * 分类互斥、顺序即优先级；页面只显示结论，不再让用户自己猜为什么没对上。
 *
 * - `experiment`：带 variant / deepScan → 冠军-挑战者管道的独立实验田，/today 按定义不展示；
 * - `retired`：style 不是现役 value → 已淘汰策略的历史结算；
 * - `intraday`：出现在当天 signals.jsonl 里 → 09:26 竞价审核之后行情变了、新票进池；
 * - `unknown`：读不到信号日志（logCodes 为 null）或确实无留痕 —— 如实说，不猜。
 *
 * 纯函数、零 IO：logCodes 由服务端 serverFn 读好后传进来，页面不碰 node 内置。
 */
export type BookOnlyReason = "experiment" | "retired" | "intraday" | "unknown";

export const BOOK_ONLY_LABEL: Record<BookOnlyReason, string> = {
  experiment: "挑战者·深扫实验",
  retired: "已淘汰策略结算",
  intraday: "盘中新增扫描",
  unknown: "未留痕",
};

export function attributeBookOnly(
  trade: ReconcileTrade,
  logCodes: Set<string> | null,
  activeStyle = "value",
): BookOnlyReason {
  if (trade.variant || trade.deepScan) return "experiment";
  if (trade.style && trade.style !== activeStyle) return "retired";
  if (logCodes == null) return "unknown";
  return logCodes.has(sixDigitCode(trade.code)) ? "intraday" : "unknown";
}

/** 一次给整组「账本独有」归类，返回与原数组同序的标签数组。 */
export function attributeBookOnlyAll(
  trades: ReconcileTrade[],
  logCodes: Set<string> | null,
  activeStyle = "value",
): BookOnlyReason[] {
  return trades.map((t) => attributeBookOnly(t, logCodes, activeStyle));
}
