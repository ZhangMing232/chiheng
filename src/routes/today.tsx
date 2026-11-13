/**
 * 这个文件是干什么的：
 * 「今日决策」页——把「市场在玩什么 → 短线买什么 → 中长线买什么 → 什么时候卖」
 * 按双轨制排在一页里，只放验证过的东西，不放研究层的噪音。
 *
 * 你需要知道的（纪律）：
 * 1. **短线只跟题材，不追高连板**：题材涨停家数≥10 次日 +0.4~0.77%（单调，已验证），
 *    但追三连板+ 每笔 −3.71%（t=−10.19，已证伪）。所以短线买的是「题材的非涨停龙头」。
 * 2. **中长线只认低估值**：value 是唯一实盘为正的策略（+0.5%），但它本质是银行 beta，
 *    不承诺。
 * 3. **什么时候买 = 情绪条件**：广度健康、炸板率<30%、非沸点。冰点不抄（次日 −0.04%）。
 * 4. 每个判断都标数据来源，不编。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useStockDetail } from "@/components/stock-detail-modal";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getMarketSnapshot } from "@/lib/market/limit-up.functions";
import { getRegulatoryRadar, getLadder3Day, type RegulatoryRow, type LadderRow } from "@/lib/market/quotes.functions";
import { getThemeHeat, getLimitUpReasons, getSignalReviewed, getServerJournal, type ThemeHeatItem, type SignalReviewed, type LimitUpReasonsPayload } from "@/lib/market/quotes.functions";
import { getForecast, type ForecastPeriod } from "@/lib/market/archive.functions";
import { getFlow } from "@/lib/market/quotes.functions";
import { ScopeNote, scopeNoteLinkClass } from "@/components/scope-note";
import { reconcileDay, reconcileSummary, sixDigitCode, type ReconcileDay, type ReconcileSignal } from "@/lib/market/daily-reconcile";

export const Route = createFileRoute("/today")({
  loader: async () => {
    const [snap, themes, reasons, reviewed, reg, ladder3, forecast, flow, journal] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {}, sectors: {} }) as LimitUpReasonsPayload),
      getSignalReviewed().catch(() => ({ date: "", ok: 0, warn: 0, skip: 0, signals: [] as SignalReviewed[] })),
      getRegulatoryRadar().catch(() => ({ date: "", rows: [] as RegulatoryRow[] })),
      getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} })),
      getForecast().catch(() => ({ locked: [] as ForecastPeriod[], backtest: null })),
      getFlow().catch(() => null),
      // 账本只取对账要用的精简字段，不把整本账（22 天 354 笔）塞进 SSR HTML。
      getServerJournal().catch(() => null),
    ]);
    const journalDays: ReconcileDay[] | null = journal
      ? journal.days.map((d) => ({
          date: d.date,
          trades: d.trades.map((t) => ({
            code: t.code, name: t.name, entry: t.entry,
            style: t.style, exit: t.exit,
          })),
        }))
      : null;
    return {
      snap, themes, reasons, reviewed, reg, ladder3, forecast, flow,
      journalDays,
      journalWhy: journal?.why ?? (journal ? null : "服务端账本没返回"),
    };
  },
  component: DecisionPage,
});

/** 情绪五档 → 动作建议（数据：沸点次日+0.38%，冰点次日−0.04%，动量市不是反转市）。 */





function moodOf(p: { breakRate: number | null; maxStreak: number; ladderCount: number }): {
  band: string;
  tone: "up" | "warn" | "muted" | "down";
  action: string;
} {
  const br = p.breakRate ?? 0;
  if (br >= 0.4) return { band: "退潮", tone: "warn", action: "炸板率高，追高被套概率大，短线少动" };
  if (p.maxStreak >= 5) return { band: "沸点", tone: "up", action: "情绪亢奋，只跟题材不追高连板（追高已证伪）" };
  if (p.ladderCount >= 15 && br < 0.25) return { band: "温和偏热", tone: "up", action: "梯队健康，短线可做题材龙头" };
  if (p.ladderCount < 5) return { band: "冰点", tone: "muted", action: "情绪冷，冰点不抄底（次日 −0.04%），观望" };
  return { band: "温和", tone: "muted", action: "中性，只做有题材支撑的票" };
}


/** 像素图标：8×8 网格用 rect 拼，shape-rendering=crispEdges，不用 emoji/位图。 */
function PxIcon({ kind, color }: { kind: "rocket" | "blade" | "shield"; color: string }) {
  const art: Record<string, string[]> = {
    rocket: ["....##..", "..##.#..", ".######.", ".######.", "..####..", "..####..", ".##..##.", ".#....#."],
    blade: ["......##", ".....###", "....###.", "...###..", "..###...", ".###....", "##......", "#......."],
    shield: ["########", "#......#", "#.####.#", "#.####.#", "#.####.#", ".#.##.#.", "..####..", "...##..."],
  };
  const rows = art[kind] ?? art.rocket;
  return (
    <svg className="h-[13px] w-[13px] shrink-0" viewBox="0 0 8 8" fill={color} aria-hidden="true" style={{ shapeRendering: "crispEdges" }}>
      {rows.flatMap((row, y) =>
        row.split("").map((ch, x) => (ch === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)),
      )}
    </svg>
  );
}


/**
 * 一天的时间轴：每一段写清「什么时候发生、数据什么时候到位」。
 *
 * 为什么要有这个：/today 上同时摆着三种时态的数据——
 *   昨天的落档（15:12 写入，今天开盘才可买）
 *   今早的竞价审核（09:26 写入，决定挂什么价）
 *   盘中的资金（约 1 分钟一更）
 * 不标时间，用户会以为「买 244.80」是现在能挂的价，其实那是今早 9:26 的竞价价。
 *
 * 所以每个节点写两行：上面是动作（几点干什么），下面是数据（几点到哪份文件）。
 */
const DAY_STAGES = [
  { key: "pre", at: "09:15", action: "集合竞价开始", data: "盘中三池开始每 3 分钟采" },
  { key: "auction", at: "09:26", action: "竞价审核 → 定买价", data: "reviewed.json 落盘" },
  { key: "live", at: "09:30", action: "开盘，按价挂单", data: "竞价价即开盘价" },
  { key: "live", at: "15:00", action: "收盘", data: "盘中数据作废，等定盘" },
  { key: "post", at: "15:12", action: "收盘封印", data: "涨停池 / K线 / 落档写入" },
  { key: "post", at: "15:15", action: "算明天", data: "题材热度 / 监管雷达 / 轮动" },
  { key: "post", at: "次日 09:20", action: "推送明天买什么", data: "读昨日落档" },
];

/** 现在处在一天的哪一段。用来在时间轴上高亮，并决定「现在」区该怎么说。 */
function stageNow(): { key: string; label: string; hint: string } {
  const d = new Date();
  const hm = d.getHours() * 60 + d.getMinutes();
  if (hm < 9 * 60 + 15) return { key: "pre", label: "盘前", hint: "还没有竞价价，矩阵里是待开盘" };
  if (hm < 9 * 60 + 30) return { key: "auction", label: "竞价中", hint: "9:26 审核刚出，价还会跳" };
  if (hm < 15 * 60) return { key: "live", label: "盘中", hint: "挂单价=今早竞价价，成交与否看现价" };
  return { key: "post", label: "盘后", hint: "今天已经结束，下面是明天的依据" };
}

function StageBar({ now }: { now: string }) {
  const st = stageNow();
  return (
    <div className="px-mod4 border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="px-num text-[12px] tracking-widest text-brand">DAY // TIMELINE</span>
        <span className="px-num text-[12px] text-muted">
          数据现状 {now} · 下面每块都标了它是什么时候的
        </span>
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-7">
        {DAY_STAGES.map((s) => {
          const on = s.key === st.key;
          return (
            <div key={s.at} className={"min-w-0 border-l-2 pl-2 " + (on ? "border-brand" : "border-line")}>
              <div className={"px-num text-[12px] tracking-wider " + (on ? "text-brand" : "text-muted")}>
                {s.at}{on ? " ← 现在" : ""}
              </div>
              <div className={"text-[13px] leading-snug " + (on ? "font-medium text-fg" : "text-muted")}>{s.action}</div>
              <div className="px-num mt-0.5 text-[12px] leading-snug text-muted">{s.data}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


/**
 * 分区头：每块内容属于「什么时候的数据」，一句话说清这区该不该动手。
 * 用户原话：「分区规划好，不然就等等误会了」——所以每区都写三件事：
 *   ① 这区是何时产出的 ② 现在能不能用它下单 ③ 用错了会怎么错
 */
function ZoneHeader({
  no,
  title,
  when,
  canAct,
  warn,
}: {
  no: string;
  title: string;
  when: string;
  canAct: boolean;
  warn: string;
}) {
  return (
    <div className={"flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 py-1 pl-3 " + (canAct ? "border-brand" : "border-line")}>
      <span className="px-num text-[12px] tracking-widest text-brand">{no}</span>
      <span className="text-[15px] font-bold tracking-tight">{title}</span>
      <span className="px-st wait">{when}</span>
      <span className={"px-num text-[12px] " + (canAct ? "text-up" : "text-muted")}>
        {canAct ? "现在可以照着做" : "只作参考，现在不动手"}
      </span>
      <span className="text-[12px] text-muted">{warn}</span>
    </div>
  );
}

/** 9:26 竞价审核之后，矩阵里的价才算定下来（盘前只能看昨天的落档）。 */
function stageAfter532(): boolean {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() >= 9 * 60 + 26;
}

function DecisionPage() {
  const { snap, themes, reasons, reviewed, reg, ladder3, forecast, flow, journalDays, journalWhy } = Route.useLoaderData();
  const { openDetail, modal } = useStockDetail();
  const pool = snap.snapshot;

  // 指标条
  const ladder = pool?.summary?.ladder ?? [];
  const limitUpCount = pool?.limitUp?.length ?? 0;
  const ladderCount = ladder.reduce((n, l) => n + (l.streak >= 2 ? l.count : 0), 0);
  const maxStreak = ladder.reduce((m, l) => Math.max(m, l.streak), 0);
  const breakRate = pool?.summary?.breakRate ?? null;
  // 封板率 = 涨停 /（涨停+炸板），对标连板网（85/(85+19)=81.7%）
  const brokenCount = pool?.broken?.length ?? 0;
  const sealRate = limitUpCount + brokenCount > 0 ? limitUpCount / (limitUpCount + brokenCount) : null;
  const mood = moodOf({ breakRate, maxStreak, ladderCount });
  // 较前值：用 3 日梯队的昨天 vs 今天（对标连板网 KPI 条的「较前值」）
  const prev = (() => {
    const ds = ladder3.dates;
    if (ds.length < 2) return null;
    const yDay = ds[ds.length - 2];
    const yLv = ladder3.ladder[yDay] ?? {};
    const yTotal = Object.values(yLv).reduce((n, arr) => n + arr.length, 0);
    const yLadder = Object.entries(yLv).reduce((n, [k, arr]) => n + (Number(k) >= 2 ? arr.length : 0), 0);
    const yTop = Math.max(0, ...Object.keys(yLv).map(Number));
    return { yTotal, yLadder, yTop };
  })();
  const delta = (cur: number, prev: number | null) => {
    if (prev == null) return null;
    const d = cur - prev;
    return d === 0 ? "持平" : d > 0 ? `+${d}` : `${d}`;
  };

  // 短线：题材（涨停家数多的）+ 龙头
  const hotThemes = themes.hot.slice(0, 6);
  // 中长线：低估值长腿
  const longSignals = reviewed.signals.filter((s) => s.leg === "long").slice(0, 8);
  const shortSignals = reviewed.signals.filter((s) => s.leg === "short").slice(0, 8);

  // 把「今天说了什么」和账本「后来真买了什么」对上账。
  // 只做展示对齐：signals 用竞价审核名单，账本用 getServerJournal 的精简字段，
  // 关联键是六位 code + 当天日期。理论成交(fill)刻意不传 —— 它不能冒充账本成交价。
  const daySignals: ReconcileSignal[] = reviewed.signals.map((s) => ({
    code: s.code, name: s.name, leg: s.leg,
    orderPrice: s.order?.price ?? null,
    fillStatus: s.fill?.status,
    verdict: s.verdict,
  }));
  const reconcile = reconcileDay({
    date: reviewed.date || pool?.date || "",
    signals: daySignals,
    days: journalDays,
    journalWhy,
  });
  // 任意一行（含前瞻票）都能按六位 code 查账本状态；同一只多笔取第一笔展示。
  const bookByCode = new Map(
    reconcile.bookTrades.map((t) => [sixDigitCode(t.code), t] as const),
  );

  // ── 三路信号合成一张矩阵（前瞻 / 短线 / 中长线）──
  // 为什么要合成一张：三条腿的价格在同一列，才比得出「今天到底哪几笔能成交」。
  type Row = {
    path: string; pathTone: string; name: string; code: string; id: string;
    price: string; priceNote: string; why: string;
    status: string; statusTone: "ok" | "no" | "wait"; dead?: boolean; exit: string;
    /** 账本真实成交状态；只用账本 entry，绝不用理论成交 fillPrice。 */
    book: string; bookTone: "ok" | "muted" | "warn";
  };
  /** 一行按六位 code 查账本。读不到时显示原因，不谎称「未买」。 */
  const bookCell = (code: string): Pick<Row, "book" | "bookTone"> => {
    if (reconcile.missing) return { book: "账本读不到", bookTone: "warn" };
    const t = bookByCode.get(sixDigitCode(code));
    return t
      ? { book: `已买 ${t.entry.toFixed(2)}`, bookTone: "ok" }
      : { book: "未买", bookTone: "muted" };
  };
  const rows: Row[] = [];

  const fp = forecast.locked[0];
  const liveByCode = new Map((fp?.live?.rows ?? []).map((r) => [r.code, r]));
  for (const k of fp?.picks ?? []) {
    const lr = liveByCode.get(k.code);
    const noBuy = lr?.buyFilled === false;
    rows.push({
      path: "前瞻", pathTone: "text-muted",
      name: k.name, code: k.code.replace(/^(sh|sz|bj)/, ""), id: k.code,
      price: lr?.buyPrice != null ? lr.buyPrice.toFixed(2) : k.basis.close.toFixed(2),
      priceNote: lr?.buyPrice != null ? "今开" : "选股价 · 待开盘",
      why: `${k.rule} · ${k.basis.streak}板${lr?.fillNote ? ` · ${lr.fillNote}` : ""}`,
      status: noBuy ? "一字板·买不进" : lr?.buyPrice != null ? "成交" : "待开盘",
      statusTone: noBuy ? "no" : lr?.buyPrice != null ? "ok" : "wait",
      dead: noBuy, exit: "当日收盘",
      ...bookCell(k.code),
    });
  }

  for (const [list, label] of [[shortSignals, "短线"], [longSignals, "中长线"]] as const) {
    for (const sig of list) {
      const skip = sig.order != null && sig.order.price == null;
      rows.push({
        path: label,
        pathTone: label === "短线" ? "text-brand" : "text-brand-text",
        name: sig.name, code: sig.code, id: sig.id,
        price: skip ? "不追高·放弃" : String(sig.order?.price ?? sig.buyPrice),
        priceNote: skip ? "" : sig.fill?.status === "filled" ? "成交" : "可买",
        why: sig.order?.basis ?? sig.order?.skipReason ?? sig.reason.slice(0, 28),
        status: skip ? "放弃" : sig.fill?.status === "filled" ? "成交" : sig.fill?.status === "missed" ? "未成交" : "待判定",
        statusTone: skip ? "no" : sig.fill?.status === "filled" ? "ok" : sig.fill?.status === "missed" ? "no" : "wait",
        dead: skip,
        exit: sig.holdDays ? `第 ${sig.holdDays} 日` : "按纪律",
        ...bookCell(sig.code),
      });
    }
  }
  const buyable = rows.filter((r) => !r.dead).length;
  const givenUp = rows.filter((r) => r.dead).length;
  const promo1 = (() => {
    const ds = ladder3.dates;
    const d = ds[ds.length - 1];
    const p = d ? (ladder3.promotion as Record<string, Record<string, { total: number; promoted: number }>>)[d] : null;
    const one = p?.["1"];
    return one && one.total > 0 ? `${((one.promoted / one.total) * 100).toFixed(0)}%` : "—";
  })();

  return (
    <>
    <Frame wide>
      <div className="px-noise flex flex-col gap-3">
        {/* ── 顶栏：阶段 + 三个徽标 ── */}
        <div className="px-mod4 flex flex-wrap items-center justify-between gap-3 border border-line bg-surface px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="px-num text-xs tracking-widest text-muted">SYS//TODAY</span>
            <span className="text-xl font-bold tracking-tight">今天<b className="text-brand">·</b>买什么</span>
            <span className="px-num text-xs text-muted">
              {pool?.date ?? "—"} · {pool?.sealed ? "收盘封印" : "盘中未定"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-st no">今日情绪档 · {mood.band}</span>
            <span className="px-st ok">候选 {buyable}</span>
            <span className="px-st wait">放弃 {givenUp}</span>
            <span className="px-num text-[12px] text-muted">账本成交 {reconcile.bookTradeCount} 笔</span>
          </div>
        </div>
        <div className="px-hazard" aria-hidden="true" />

        <StageBar now={`${pool?.date ?? "—"} ${pool?.sealed ? "收盘封印" : "盘中未定"}`} />

        {/* ── 指标带：等宽大数字 ── */}
        <div className="grid grid-cols-3 gap-px overflow-hidden border border-line bg-line sm:grid-cols-6">
          {[
            { label: "涨停", value: String(limitUpCount), delta: prev ? delta(limitUpCount, prev.yTotal) : null, tone: "text-fg" },
            { label: "连板", value: String(ladderCount), delta: prev ? delta(ladderCount, prev.yLadder) : null, tone: "text-fg" },
            { label: "最高板", value: String(maxStreak), delta: prev ? delta(maxStreak, prev.yTop) : null, tone: "text-brand" },
            { label: "炸板率", value: breakRate != null ? `${(breakRate * 100).toFixed(0)}%` : "—", delta: null, tone: "text-warn" },
            { label: "封板率", value: sealRate != null ? `${(sealRate * 100).toFixed(0)}%` : "—", delta: null, tone: "text-fg" },
            { label: "今日情绪档", value: mood.band, delta: null, tone: "text-warn" },
          ].map((k) => (
            <div key={k.label} className="relative bg-surface px-3 pb-3 pt-4">
              <span className="px-ticks" aria-hidden="true" />
              <div className="px-num text-[12px] tracking-widest text-muted">{k.label}</div>
              <div className={"px-num px-chroma px-reel mt-1 text-4xl font-bold leading-none " + k.tone}>{k.value}</div>
              {k.delta ? <div className="px-num mt-1 text-[12px] text-muted">较前值 {k.delta}</div> : null}
            </div>
          ))}
        </div>

        {/* 口径说明：/cycle 的「周期阶段」是另一套量纲。不写清楚，用户会拿
            「今日情绪档 温和」去对「周期阶段 冰点」，以为同一个指标自相矛盾。 */}
        <ScopeNote
          label="今日情绪档"
          link={
            <Link to="/cycle" className={scopeNoteLinkClass}>
              /cycle 周期阶段 →
            </Link>
          }
          after="按 250 日温度分位算、只在收盘后更新；两边口径不同，同名的「冰点 / 退潮」定义也不同。"
        >
          {pool?.date ?? "—"} {pool?.sealed ? "收盘定格" : "盘中快取（收盘前还会变）"} ·
          按炸板率 / 最高板 / 连板数的绝对阈值分五档；四条阈值都不命中就落默认「温和」，不是判出了温和。
        </ScopeNote>

        <ZoneHeader
          no="①"
          title="昨收依据"
          when="昨日 15:10–15:15 写入"
          canAct={false}
          warn="说明昨天钱在哪个题材、哪些票触了异动线；它不进今天挂单价"
        />

        {/* ── 当日主线 + 题材强度（2026-11-12 从总览 / 搬回：合并时漏了这两块）── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">THEMES // STRENGTH</span>
          <span className="px-st wait">昨日 15:10</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">涨停家数多的在前 · 龙头 = 板内涨幅最高且没涨停的那只</span>
        </div>

        <div className="px-mod4 grid gap-0 border border-line bg-surface md:grid-cols-[minmax(0,240px)_1fr]">
          {/* 当日主线：只写一个答案，不给备选 */}
          <div className="border-b border-line px-4 py-3 md:border-b-0 md:border-r">
            <div className="px-num text-[12px] tracking-widest text-brand">MAIN_LINE</div>
            {hotThemes[0] ? (
              <>
                <div className="mt-1 text-xl font-bold leading-tight">{hotThemes[0].name}</div>
                <div className="px-num mt-1 text-3xl font-bold text-brand">{hotThemes[0].limitUp}<span className="ml-1 text-[12px] font-normal text-muted">涨停</span></div>
                <div className="mt-1 text-[12px] text-muted">
                  均涨 {hotThemes[0].avg >= 0 ? "+" : ""}{hotThemes[0].avg.toFixed(1)}% · 成员 {hotThemes[0].n}
                  {hotThemes[0].leader ? <> · 龙头 <b className="text-fg">{hotThemes[0].leader.name}</b> {hotThemes[0].leader.chg >= 0 ? "+" : ""}{hotThemes[0].leader.chg.toFixed(1)}%</> : null}
                </div>
              </>
            ) : (
              <div className="mt-2 text-sm text-muted">今天没有烧起来的题材。</div>
            )}
          </div>

          {/* 题材强度：一格一只涨停，横条按最强题材归一化 */}
          <div className="px-4 py-3">
            <div className="px-num mb-1 text-[12px] tracking-widest text-brand">STRENGTH</div>
            {hotThemes.length === 0 ? (
              <div className="py-2 text-sm text-muted">题材热度还没算（theme-heat 收盘后跑）。</div>
            ) : (
              hotThemes.map((t) => {
                const max = Math.max(1, ...hotThemes.map((x) => x.limitUp));
                return (
                  <div key={t.name} className="flex items-center gap-3 border-b border-dashed border-line py-1.5 last:border-0">
                    <span className="w-28 shrink-0 truncate text-sm">{t.name}</span>
                    <span className="h-2 min-w-0 flex-1 bg-line">
                      <span className="block h-full bg-brand" style={{ width: `${(t.limitUp / max) * 100}%` }} />
                    </span>
                    <span className="px-num w-8 shrink-0 text-right text-sm text-fg">{t.limitUp}</span>
                    <span className="px-num w-24 shrink-0 truncate text-right text-[12px] text-muted">{t.leader?.name ?? "—"}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <ZoneHeader
          no="②"
          title="今晨定价"
          when="今日 09:26 竞价审核"
          canAct={stageAfter532()}
          warn="这一区的价是今早竞价定的；开盘后才拿到开盘价，收盘后它就不再变"
        />

        {/* ── 两批票的来历：前瞻链 vs 信号链，互不相干 ──
            用户原话：「页面东一个西一个」。把矩阵上方的分区说清：这一张表里混着
            两套独立扫描出来的票，前瞻链是昨收落档、信号链是今早竞价审核，
            两套各自选股、不互相引用，重合纯属巧合。不写清，用户会以为
            「前瞻命中的票又被竞价审核复选了一遍」。 */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">TWO_CHAINS</span>
          <span className="px-st wait">两套独立扫描 · 重合是巧合不是联动</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">下面的矩阵把两批票放在同一张表里比，路列标了每只来自哪条链</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="border border-line bg-surface px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="px-path text-muted"><PxIcon kind="rocket" color="#22e6ff" /> 前瞻链</span>
              <span className="px-num text-[12px] text-muted">连板 / 封单 · 昨收落档</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              来自昨收后的落档（forecast.locked，隔夜持仓），落档之后不改。是「昨天收盘后定好、今天开盘前就挂着」的那批——它们不进竞价审核名单。
            </p>
          </div>
          <div className="border border-line bg-surface px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="px-path text-brand-text"><PxIcon kind="blade" color="#22e6ff" /> 信号链</span>
              <span className="px-num text-[12px] text-muted">低估值 / 题材补涨 · 今早 09:26 竞价审核</span>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              来自今早竞价审核（reviewed.json）：短线跟题材、中长线跟低估值。和前瞻链是两套不同的扫描，各自独立选股，没有谁复选谁。
            </p>
          </div>
        </div>

        {/* ── 买入矩阵 ── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">BUY_MATRIX</span>
          <span className="px-st ok">今晨 09:26 竞价审核</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">买价 = 能成交的价 · 高开超过自身振幅即放弃</span>
        </div>

        <div className="px-mod4 overflow-x-auto border border-line bg-surface">
          <table className="px-tbl">
            <thead>
              <tr>
                <th>路</th><th>标的</th><th style={{ textAlign: "right" }}>买价</th><th>依据</th><th>状态</th><th>账本</th><th>走</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path + r.code} className={(r.dead ? "is-dead " : "") + "px-jitter"}>
                  <td className={"px-path " + r.pathTone}>
                    <span className="inline-flex items-center gap-1.5">
                      <PxIcon
                        kind={r.path === "前瞻" ? "rocket" : r.path === "短线" ? "blade" : "shield"}
                        color={r.dead ? "#ff6ea4" : r.path === "中长线" ? "#a6ff3d" : "#22e6ff"}
                      />
                      {r.path}
                    </span>
                  </td>
                  <td>
                    <button type="button" onClick={() => void openDetail(r.id, r.name)} className="px-name hover:underline">{r.name}</button>
                    <span className="px-code">{r.code}</span>
                  </td>
                  <td className="px-price text-brand">
                    {r.price}
                    {r.priceNote ? <small className="block text-[12px] font-normal text-muted">{r.priceNote}</small> : null}
                  </td>
                  <td className="px-why">{r.why}</td>
                  <td><span className={"px-st " + r.statusTone}>{r.status}</span></td>
                  <td>
                    <span className={"px-num text-[12px] " + (r.bookTone === "ok" ? "text-brand" : r.bookTone === "warn" ? "text-warn" : "text-muted")}>
                      {r.book}
                    </span>
                  </td>
                  <td className="px-why">{r.exit}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="px-why" style={{ padding: 16 }}>今天三路都没有候选。</td></tr>
              ) : null}
            </tbody>
          </table>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            前瞻命中 49.1%（基准 46.0%）· 追买 87.9% 跑输 94.4% · 8.3% 一字板买不进 · 低估值线上 20 笔 +3.33pp 但从未回测验证 · 题材补涨 +0.06% 无超额。<b className="text-fg">能买到 ≠ 更能赚。</b>
          </div>
          {/* 对账：把「今天说了什么」和账本「真买了什么」摆在一起，两边不再各说各的。 */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            <span className="px-num tracking-widest text-brand">对账 // {reconcile.date || "日期未知"}</span>
            <span className="text-fg">{reconcileSummary(reconcile)}</span>
            <span>· /today 有账本没买 {reconcile.signalOnly.length} 只 · 账本买了本页没提 {reconcile.bookOnly.length} 笔</span>
            {reconcile.missing ? <span className="text-warn">{reconcile.missing}，「未买」不可信</span> : null}
            <Link to="/strategies/positions" className={scopeNoteLinkClass}>策略追踪 →</Link>
          </div>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            「状态」是按当天日 K <b className="text-fg">事后重算的理论成交</b>；「账本」是记账进程
            <b className="text-fg">当时记下的真实成交</b>。两者口径不同，列在一起只为对得上号，
            本页不拿理论价冒充成交价，也不改任何买卖。
          </div>
        </div>

        <ZoneHeader
          no="③"
          title="执行与卖出"
          when="买入后每一刻"
          canAct
          warn="这里管的是「什么时候走」，不看它就会忘记止损和到期"
        />

        {/* ── 作战块：纪律 + 盯什么 ── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">OPS // EXIT · WATCH</span>
          <span className="px-st wait">昨日 15:15</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">纪律写死，盘中不改</span>
        </div>

        <div className="px-mod4 grid gap-0 border border-line bg-surface sm:grid-cols-2">
          <div className="px-4 py-3">
            <div className="px-num mb-2 text-[12px] tracking-widest text-brand">EXIT / 什么时候卖</div>
            <div className="flex gap-2 border-b border-dashed border-line py-1.5 text-sm"><span className="px-num w-16 shrink-0 text-[12px] text-muted">SHORT</span><span>断板，或炸板率升到 40% 以上 → 走。<b className="text-warn">今天 {breakRate != null ? (breakRate * 100).toFixed(0) : "—"}%</b></span></div>
            <div className="flex gap-2 border-b border-dashed border-line py-1.5 text-sm"><span className="px-num w-16 shrink-0 text-[12px] text-muted">LONG</span><span>跌破止损 −8% / 到目标 +10% / 20 日线破位 → 走，先到先走。</span></div>
            <div className="flex gap-2 py-1.5 text-sm"><span className="px-num w-16 shrink-0 text-[12px] text-muted">T+1</span><span>买入当天不卖；第 N 个交易日收盘卖（短线 5 / 中长线 8）。</span></div>
          </div>
          <div className="border-t border-line px-4 py-3 sm:border-l sm:border-t-0">
            <div className="px-num mb-2 text-[12px] tracking-widest text-brand">WATCH / 盯什么</div>
            <div className="flex justify-between gap-3 border-b border-dashed border-line py-1.5 text-sm"><span className="text-muted">监管异动 · 已达线</span><span className="px-num text-warn">{reg.rows.filter((r) => r.level === "已达").length} 只</span></div>
            <div className="flex justify-between gap-3 border-b border-dashed border-line py-1.5 text-sm"><span className="text-muted">题材 · 最热</span><span className="px-num">{hotThemes[0] ? `${hotThemes[0].name} ${hotThemes[0].limitUp}` : "—"}</span></div>
            <div className="flex justify-between gap-3 py-1.5 text-sm"><span className="text-muted">1→2 晋级率</span><span className="px-num">{promo1}</span></div>
          </div>
        </div>

        {/* 手机端固定结论条：一屏看完不用往上滚。窄屏才出现，桌面端隐藏。 */}
        <div className="px-mobile-bar sm:hidden" aria-hidden="true">
          <div className="px-num text-[12px] text-muted">
            今日情绪档 <b className="text-warn">{mood.band}</b> · 可买 <b className="text-brand">{buyable}</b> · 放弃 <b className="text-fg">{givenUp}</b>
          </div>
          <div className="px-num text-[12px] text-brand">看矩阵 ▾</div>
        </div>

        <div className="px-ticks-x" aria-hidden="true" />
        <div className="px-barcode" aria-hidden="true" />

        <div className="px-num text-[12px] leading-relaxed text-muted">
          // 买价＝竞价价（能成交）。高开超出该股近 5 日振幅的一半就放弃，不给买不到的挂单价。<br />
          // 前瞻 3 只为自证记录，落档之后不改。本页只陈述已测到的数字，不构成投资建议。
        </div>
      </div>
    </Frame>
    {modal}
    </>
  );
}
