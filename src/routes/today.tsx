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
import { getThemeHeat, getLimitUpReasons, getSignalReviewed, type ThemeHeatItem, type SignalReviewed, type LimitUpReasonsPayload } from "@/lib/market/quotes.functions";
import { getForecast, type ForecastPeriod } from "@/lib/market/archive.functions";
import { getFlow } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/today")({
  loader: async () => {
    const [snap, themes, reasons, reviewed, reg, ladder3, forecast, flow] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {}, sectors: {} }) as LimitUpReasonsPayload),
      getSignalReviewed().catch(() => ({ date: "", ok: 0, warn: 0, skip: 0, signals: [] as SignalReviewed[] })),
      getRegulatoryRadar().catch(() => ({ date: "", rows: [] as RegulatoryRow[] })),
      getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} })),
      getForecast().catch(() => ({ locked: [] as ForecastPeriod[], backtest: null })),
      getFlow().catch(() => null),
    ]);
    return { snap, themes, reasons, reviewed, reg, ladder3, forecast, flow };
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

function DecisionPage() {
  const { snap, themes, reasons, reviewed, reg, ladder3, forecast, flow } = Route.useLoaderData();
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

  // ── 三路信号合成一张矩阵（前瞻 / 短线 / 中长线）──
  // 为什么要合成一张：三条腿的价格在同一列，才比得出「今天到底哪几笔能成交」。
  type Row = {
    path: string; pathTone: string; name: string; code: string; id: string;
    price: string; priceNote: string; why: string;
    status: string; statusTone: "ok" | "no" | "wait"; dead?: boolean; exit: string;
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
            <span className="text-lg font-bold tracking-tight">今天<b className="text-brand">·</b>买什么</span>
            <span className="px-num text-xs text-muted">{pool?.date ?? "—"} · 收盘封印</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-st no">{mood.band}</span>
            <span className="px-st ok">可买 {buyable}</span>
            <span className="px-st wait">放弃 {givenUp}</span>
          </div>
        </div>
        <div className="px-hazard" aria-hidden="true" />

        {/* ── 指标带：等宽大数字 ── */}
        <div className="grid grid-cols-3 gap-px overflow-hidden border border-line bg-line sm:grid-cols-6">
          {[
            { label: "涨停", value: String(limitUpCount), delta: prev ? delta(limitUpCount, prev.yTotal) : null, tone: "text-fg" },
            { label: "连板", value: String(ladderCount), delta: prev ? delta(ladderCount, prev.yLadder) : null, tone: "text-fg" },
            { label: "最高板", value: String(maxStreak), delta: prev ? delta(maxStreak, prev.yTop) : null, tone: "text-brand" },
            { label: "炸板率", value: breakRate != null ? `${(breakRate * 100).toFixed(0)}%` : "—", delta: null, tone: "text-warn" },
            { label: "封板率", value: sealRate != null ? `${(sealRate * 100).toFixed(0)}%` : "—", delta: null, tone: "text-fg" },
            { label: "情绪", value: mood.band, delta: null, tone: "text-warn" },
          ].map((k) => (
            <div key={k.label} className="relative bg-surface px-3 pb-3 pt-4">
              <span className="px-ticks" aria-hidden="true" />
              <div className="px-num text-[12px] tracking-widest text-muted">{k.label}</div>
              <div className={"px-num px-chroma px-reel mt-1 text-4xl font-bold leading-none " + k.tone}>{k.value}</div>
              {k.delta ? <div className="px-num mt-1 text-[12px] text-muted">较前值 {k.delta}</div> : null}
            </div>
          ))}
        </div>

        {/* ── 买入矩阵 ── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">BUY_MATRIX</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">买价 = 能成交的价 · 高开超过自身振幅即放弃</span>
        </div>

        <div className="px-mod4 overflow-x-auto border border-line bg-surface">
          <table className="px-tbl">
            <thead>
              <tr>
                <th>路</th><th>标的</th><th style={{ textAlign: "right" }}>买价</th><th>依据</th><th>状态</th><th>走</th>
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
                  <td className="px-why">{r.exit}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr><td colSpan={6} className="px-why" style={{ padding: 16 }}>今天三路都没有候选。</td></tr>
              ) : null}
            </tbody>
          </table>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            前瞻命中 49.1%（基准 46.0%）· 追买 87.9% 跑输 94.4% · 8.3% 一字板买不进 · 低估值线上 20 笔 +3.33pp 但从未回测验证 · 题材补涨 +0.06% 无超额。<b className="text-fg">能买到 ≠ 更能赚。</b>
          </div>
        </div>

        {/* ── 作战块：纪律 + 盯什么 ── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">OPS // EXIT · WATCH</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">纪律写死，盘中不改</span>
        </div>

        <div className="px-mod4 grid gap-0 border border-line bg-surface sm:grid-cols-2">
          <div className="px-4 py-3">
            <div className="px-num mb-2 text-[12px] tracking-widest text-brand">EXIT / 什么时候卖</div>
            <div className="flex gap-2 border-b border-dashed border-line py-1.5 text-[13px]"><span className="px-num w-16 shrink-0 text-[12px] text-muted">SHORT</span><span>断板，或炸板率升到 40% 以上 → 走。<b className="text-warn">今天 {breakRate != null ? (breakRate * 100).toFixed(0) : "—"}%</b></span></div>
            <div className="flex gap-2 border-b border-dashed border-line py-1.5 text-[13px]"><span className="px-num w-16 shrink-0 text-[12px] text-muted">LONG</span><span>跌破止损 −8% / 到目标 +10% / 20 日线破位 → 走，先到先走。</span></div>
            <div className="flex gap-2 py-1.5 text-[13px]"><span className="px-num w-16 shrink-0 text-[12px] text-muted">T+1</span><span>买入当天不卖；第 N 个交易日收盘卖（短线 5 / 中长线 8）。</span></div>
          </div>
          <div className="border-t border-line px-4 py-3 sm:border-l sm:border-t-0">
            <div className="px-num mb-2 text-[12px] tracking-widest text-brand">WATCH / 盯什么</div>
            <div className="flex justify-between gap-3 border-b border-dashed border-line py-1.5 text-[13px]"><span className="text-muted">监管异动 · 已达线</span><span className="px-num text-warn">{reg.rows.filter((r) => r.level === "已达").length} 只</span></div>
            <div className="flex justify-between gap-3 border-b border-dashed border-line py-1.5 text-[13px]"><span className="text-muted">题材 · 最热</span><span className="px-num">{hotThemes[0] ? `${hotThemes[0].name} ${hotThemes[0].limitUp}` : "—"}</span></div>
            <div className="flex justify-between gap-3 py-1.5 text-[13px]"><span className="text-muted">1→2 晋级率</span><span className="px-num">{promo1}</span></div>
          </div>
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
