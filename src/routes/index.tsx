/**
 * 这个文件是干什么的：
 * 总览首页（《赤轨 UI 升级方案 2026-10》首页 Zone A–D，直接替换旧主控台）。
 * 目标：30 秒看懂「市场怎么样 + 系统正不正常」，全站第一屏的成品感在这页立住。
 *
 * 分区（2026-11-11 用户拍板重排，按「先判断位置 → 盘面 → 个股 → 状态」）：
 * - 第一行 决策：情绪温度计 + 冰点沸点时机判定（标证据等级）+ 各种指数
 * - 第二行 盘面：大盘分时 + 具体个股连板/涨停 + 热门概念 + 下一个可能热门
 * - 第三行 个股：今日盘前候选（预登记策略筛出）+ 今日模拟盘成交
 * - 第四行 状态：项目情况 + 资金/全球对照 + 热点快讯
 *
 * 纪律：
 * - 全部复用现成接口，任何一块拉失败都降级成说明，不造假数。
 * - 全市场快照照旧在 loader 里瘦身（~5300 只进 SSR HTML 会把手机端卡死），
 *   涨跌家数用现成的 getBreadth（服务端算好，不塞全量快照给浏览器）。
 * - **不放任何买卖建议**（red-line.ts 红线）。前瞻判断逐条标证据等级，
 *   没验过的不写成确定结论；「今日盘前候选」是数据复述，不是买入推荐。
 * - 三池走盘后心跳落盘的快照（getMarketSnapshot），**绝不进 SSR loader 实时采集**：
 *   东财 3 池串行 ×1300ms 曾把 GET / 拖到 4.386620s。
 */

import { createFileRoute } from "@tanstack/react-router";
import { getLimitUpReasons, getLadder3Day, type LimitUpReasonsPayload, type LadderRow } from "@/lib/market/quotes.functions";
import { Link } from "@tanstack/react-router";
import { useStockDetail } from "@/components/stock-detail-modal";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, Prog, pctClass } from "@/components/terminal";
import { SentimentGauge } from "@/components/sentiment-gauge";
import { Clock, Gauge, ShieldCheck } from "lucide-react";
import { HeroStat } from "@/components/hero-stat";
import { sessionPhase } from "@/lib/market/session";
import { journalTradeIds, slimUniverse as slimUniverseByIds } from "@/lib/market/slim-universe";
import { computeSentiment } from "@/lib/market/sentiment";
import { getMarketSnapshot } from "@/lib/market/limit-up.functions";
import { continuationOf, LAGGARD_EVIDENCE } from "@/lib/market/theme-continuation";
import type { Breadth } from "@/lib/market/slim-universe";
import type { IndexQuote, Quote, SessionInfo } from "@/lib/market/types";
import type { NewsItem } from "@/lib/market/news";
import type { PaperDay } from "@/lib/paper";
import type { FlowBook } from "@/lib/market/flow";
import {
  getBreadth,
  getChallengerSamples,
  getChallengers,
  getFlow,
  getIndices,
  getNews,
  getRecorder,
  getServerJournal,
  getStrategyGates,
  getThemeHeat,
  getSignalReviewed,
  getTrend,
  getUniverse,
  type ThemeHeatItem,
  type SignalReviewed,
} from "@/lib/market/quotes.functions";
import { getOverseasIndices } from "@/lib/market/overseas-list.functions";

/** 首页要的数据一次取齐。任何一块拉失败都降级成空，不让整页打不开。 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const phase = sessionPhase();
    const [indices, journal, universe, recorder, flow, breadth, challengers, samples, overseas, news, gatesData, pools, themes, reviewed, reasonsData, ladder3] =
      await Promise.all([
        getIndices().catch(() => [] as IndexQuote[]),
        getServerJournal().catch(() => ({ days: [] as PaperDay[], personal: false, why: "账本暂时读不到" })),
        getUniverse({ data: { refresh: false } }).catch(() => null),
        getRecorder().catch(() => ({ at: null, ok: false })),
        getFlow().catch(() => null as FlowBook | null),
        getBreadth().catch(() => null as Breadth | null),
        getChallengers().catch(() => ({ list: [], champions: {} })),
        getChallengerSamples().catch(() => ({}) as Record<string, { n: number; target: number; champN: number }>),
        getOverseasIndices().catch(() => ({ quotes: [] as IndexQuote[], gaps: [] as string[] })),
        getNews().catch(() => [] as NewsItem[]),
        getStrategyGates().catch(() => ({ gates: {} })),
        // 三池只读盘后心跳落盘的快照，零外部请求。原来这里直接调 getSignals，
        // 3 个东财池串行 ×1300ms 把 GET / 拖到 4.39 秒（2026-11-11 回归）。
        getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
        getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
        getSignalReviewed().catch(() => ({ date: "", ok: 0, warn: 0, skip: 0, signals: [] as SignalReviewed[] })),
        // 涨停原因（fetch-limit-up-reason.ts 收盘后采，转发韭研/开盘啦）
        getLimitUpReasons().catch(() => ({ date: "", reasons: {}, sectors: {} }) as LimitUpReasonsPayload),
        // 3 日梯队（算较前值）
        getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} })),
      ]);
    // 大盘分时用第一只指数画（getTrend 只认常用指数白名单，索引行情出来的 id 一定在）。
    const trend = indices[0]
      ? await getTrend({ data: { id: indices[0].id } }).catch(() => null)
      : null;
    // 全市场快照 ~5300 只、进 SSR HTML 有 1.2MB，手机端解析时会卡到点不动。
    // 首页只用持仓相关的几只（priceOf 按 id 查现价/涨跌），先按账本 id 瘦身再返回。
    const slimUniverse = slimUniverseByIds(universe, journalTradeIds(journal));
    // 情绪温度计在服务端算好（分量全是上面的真实数据，计算本身在 lib 里有测试钉着）。
    // 连板高度 + 炸板率是「情绪周期」维度：连板高 = 沸点、炸板率高 = 退潮。
    // 读不到快照就退化成四分量（null 是「不知道」，不补 0）。
    const poolSnap = pools.snapshot;
    const sentiment = breadth
      ? computeSentiment(
          breadth,
          indices.map((item) => item.pct),
          flow ? flow.market.reduce((total, part) => total + part.main, 0) : null,
          poolSnap?.summary?.ladder ?? null,
          poolSnap?.summary?.breakRate ?? null,
        )
      : null;
    // 数据时间脚注：指数行情的时间戳最可靠；没有就标未知。
    const stamp =
      phase.date && indices[0]?.time
        ? new Date(`${phase.date}T${indices[0].time}`).getTime()
        : null;
    return {
      phase, indices, journal, universe: slimUniverse, recorder, trend, flow,
      breadth, sentiment, stamp, pools, themes, reviewed,
      // 行情新鲜度条的「延迟」依赖当前时刻：放进 loader 算一次、随 loader 数据序列化，
      // SSR 与客户端 hydration 拿到的是同一个值，不会因服务端/客户端时刻差触发 #418。
      serverNow: Date.now(),
      runningChallengers: challengers.list.filter((c) => c.status === "running"),
      challengerSamples: samples,
      overseas: overseas.quotes.slice(0, 6),
      overseasGaps: overseas.gaps,
      news: news.slice(0, 6),
      reasons: reasonsData.reasons,
      sectors: reasonsData.sectors,
      ladder3,
      gates: gatesData.gates,
    };
  },
  component: Dashboard,
});

import { ACTIVE_STYLES } from "@/lib/market/strategies";

function todayStr(phase: SessionInfo): string {
  return phase.date ?? "";
}

/** 万元 → 「x.x 亿」 */
function yi(wan: number | null): string {
  return wan == null ? "—" : `${(wan / 10_000).toFixed(1)} 亿`;
}

function Dashboard() {
  const {
    phase, indices, journal, universe, recorder, trend, flow,
    breadth, sentiment, stamp, serverNow, pools, themes, reviewed,
    runningChallengers, challengerSamples, overseas, overseasGaps, news,
    gates, reasons, ladder3,
  } = Route.useLoaderData();
  const { openDetail, modal } = useStockDetail();
  const date = todayStr(phase);
  const todayDay = journal.days.find((day) => day.date === date) ?? null;
  const buysToday = todayDay?.trades ?? [];
  const sellsToday = journal.days.flatMap((day) =>
    day.trades.filter((trade) => trade.exit != null && trade.exitDate === date),
  );
  const openTrades = journal.days.flatMap((day) => day.trades.filter((trade) => trade.exit == null));
  const styles = [...new Set(openTrades.map((trade) => trade.style ?? "other"))];
  const priceOf = (id: string): Quote | null => universe?.quotes.find((quote) => quote.id === id) ?? null;
  const mainInflow = flow ? flow.market.reduce((total, part) => total + part.main, 0) : null;
  const northAmount = flow && flow.north.length ? flow.north.reduce((total, leg) => total + leg.amount, 0) : null;
  const tapeAmount = flow && flow.tape.length ? flow.tape.reduce((total, row) => total + row.amount, 0) : null;
  const prevTape = flow && flow.tape.length
    ? flow.tape.reduce((total, row) => total + (row.prevAmount ?? 0), 0)
    : null;
  // 用 loader 下发的 serverNow，不在 render 里读系统时钟（否则 SSR/hydration 会 #418）。
  const recorderDead = recorder.at == null || serverNow - recorder.at > 3 * 60_000;

  // ── KPI 头版 + 市场结论（2026-11-10 效果图重构）：全部真实计数，不编分 ──
  const delaySec = universe?.asOf ? Math.max(0, Math.round((serverNow - universe.asOf) / 1000)) : null;
  const gatesOff = (Object.values(gates) as { state?: string }[]).filter((g) => g.state === "disabled").length;
  const recorderFresh = recorder.at != null && serverNow - recorder.at < 5 * 60_000;
  const checks = [
    { label: "自动记账", ok: recorderFresh },
    { label: "行情", ok: delaySec != null && delaySec < 300 },
    { label: "风控闸门", ok: gatesOff === 0 },
    { label: "指数数据", ok: indices.length > 0 },
  ];
  const healthScore = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  const hs300 = indices.find((i) => i.id === "sh000300") ?? indices[0];
  const tapeChgPct = tapeAmount != null && prevTape ? (tapeAmount / prevTape - 1) * 100 : null;
  const marketFacts = [
    breadth
      ? `上涨 ${breadth.up} 家 vs 下跌 ${breadth.down} 家，${breadth.up >= breadth.down ? "涨多跌少" : "跌多涨少"}（涨停 ${breadth.limitUp} · 跌停 ${breadth.limitDown}）`
      : null,
    tapeAmount != null
      ? `两市成交 ${yi(tapeAmount)}${tapeChgPct != null ? `，较昨日 ${tapeChgPct >= 0 ? "+" : ""}${tapeChgPct.toFixed(1)}%` : ""}`
      : null,
    mainInflow != null ? `主力资金净${mainInflow >= 0 ? "流入" : "流出"} ${yi(Math.abs(mainInflow))}（超大单 + 大单）` : null,
    hs300 ? `沪深300 ${hs300.pct > 0 ? "+" : ""}${hs300.pct.toFixed(2)}%，${indices.filter((i) => i.pct > 0).length}/${indices.length} 个主要指数上涨` : null,
    sentiment?.score != null ? `情绪温度 ${sentiment.score}「${sentiment.band}」` : null,
  ].filter((f): f is string => f != null);

  // ── 2026-11-11 新增三块：连板个股 / 热门概念 / 下一个可能热门 ──
  // 全部只读落盘快照，不现场拉外部接口；读不到就给空态，不拿空数组冒充「今天没有」。
  const poolSnap = pools.snapshot;
  const limitRows = poolSnap?.limitUp ?? [];
  // 连板梯队：按连板数分组、组内全量（面板内滚动），不截断——用户要的是完整梯队。
  const ladderGroups = (() => {
    const m = new Map<number, typeof limitRows>();
    for (const r of limitRows) {
      const st = r.streak ?? 1;
      const arr = m.get(st) ?? [];
      arr.push(r);
      m.set(st, arr);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([streak, rows]) => ({ streak, rows }));
  })();
  const brokenRows = poolSnap?.broken ?? [];
  const hotThemes = themes.hot.slice(0, 4);
  const shortSignals = reviewed.signals.filter((s) => s.leg === "short").slice(0, 5);
  const longSignals = reviewed.signals.filter((s) => s.leg === "long").slice(0, 5);
  const candidateCount = reviewed.signals.length;
  const poolFresh = poolSnap
    ? `${poolSnap.date} ${poolSnap.sealed ? "收盘后" : "盘中未定"}`
    : null;
  // 关键指标条：复盘第一眼（对标连板网/弈盘顶部一排数字）
  const limitUpCount = poolSnap?.limitUp.length ?? 0;
  const ladderCount = poolSnap?.summary?.ladder?.reduce((n, l) => n + (l.streak >= 2 ? l.count : 0), 0) ?? 0;
  const maxStreak = poolSnap?.summary?.ladder?.reduce((m, l) => Math.max(m, l.streak), 0) ?? 0;
  const limitDownCount = poolSnap?.limitDown.length ?? 0;
  const breakRateVal = poolSnap?.summary?.breakRate ?? null;
  const brokenCount = poolSnap?.broken?.length ?? 0;
  const sealRate = limitUpCount + brokenCount > 0 ? limitUpCount / (limitUpCount + brokenCount) : null;
  const prev = (() => {
    const ds = ladder3.dates;
    if (ds.length < 2) return null;
    const yLv = ladder3.ladder[ds[ds.length - 2]] ?? {};
    return {
      total: Object.values(yLv).reduce((n, arr) => n + arr.length, 0),
      ladder: Object.entries(yLv).reduce((n, [k, arr]) => n + (Number(k) >= 2 ? arr.length : 0), 0),
      top: Math.max(0, ...Object.keys(yLv).map(Number)),
    };
  })();
  const delta = (cur: number, pv: number | null) => (pv == null ? null : cur - pv === 0 ? "持平" : cur - pv > 0 ? `+${cur - pv}` : `${cur - pv}`);

  return (
    <>
    <Frame
      wide
      status={{
        label: "今日信号",
        value: `${buysToday.length + sellsToday.length} 条`,
        tone: buysToday.length + sellsToday.length > 0 ? "brand" : "neutral",
      }}
      freshness={
        universe
          ? {
              state: universe.stale ? "delayed" : "healthy",
              label: universe.stale ? "行情延迟" : "行情正常",
              source: "腾讯行情 · 备份新浪",
              updatedAt: universe.asOf ? new Date(universe.asOf).toTimeString().slice(0, 8) : undefined,
              latencySeconds: universe.asOf ? Math.round((serverNow - universe.asOf) / 1000) : undefined,
              message: universe.stale ? "当前数据仅供查看，别拿它当现价用" : undefined,
              canRetry: true,
            }
          : { state: "unavailable", label: "行情还没拉到", message: "点重试再拉一次", canRetry: true }
      }
    >
      {/* ── 关键指标条：复盘第一眼，对标连板网/弈盘顶部那一排（带较前值）── */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-7">
        <div className="bg-surface px-3 py-2"><KeyNum label="涨停" value={poolSnap ? limitUpCount : null} tone="text-up" hint={prev ? `较前值 ${delta(limitUpCount, prev.total)}` : undefined} /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="连板" value={poolSnap ? ladderCount : null} tone="text-up" hint={prev ? `较前值 ${delta(ladderCount, prev.ladder)}` : undefined} /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="最高板" value={poolSnap ? `${maxStreak}板` : null} hint={prev ? `较前值 ${delta(maxStreak, prev.top)}` : undefined} /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="跌停" value={poolSnap ? limitDownCount : null} tone="text-down" /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="炸板率" value={breakRateVal != null ? `${(breakRateVal * 100).toFixed(0)}%` : null} /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="封板率" value={sealRate != null ? `${(sealRate * 100).toFixed(1)}%` : null} tone="text-up" /></div>
        <div className="bg-surface px-3 py-2"><KeyNum label="情绪温度" value={sentiment?.score != null ? `${sentiment.score}°` : null} hint={sentiment?.band ?? undefined} /></div>
      </div>

      {/* ── 锚点导航：一眼跳到各段（对标连板网速览）── */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-3 py-1.5 text-xs">
        <span className="text-muted">速览</span>
        <a href="#s-main" className="text-accent hover:underline">当日主线</a>
        <a href="#s-strength" className="text-accent hover:underline">主线强度</a>
        <a href="#s-money" className="text-accent hover:underline">主力资金</a>
        <a href="#s-positions" className="text-accent hover:underline">持仓</a>
        <Link to="/ladder" className="text-accent hover:underline">连板天梯 →</Link>
        <Link to="/grid" className="text-accent hover:underline">多股同屏 →</Link>
        <Link to="/cycle" className="text-accent hover:underline">情绪周期 →</Link>
        <Link to="/brief" className="text-accent hover:underline">题材简报 →</Link>
        <Link to="/decision" className="text-accent hover:underline">今日决策 →</Link>
      </div>

      {/* ── 当日主线：总龙头 + 板块 + 涨停家数（对标连板网当日主线）── */}
      <div id="s-main" className="grid gap-2 lg:grid-cols-3">
        <Panel title="当日主线" note="题材涨停家数排序 · 龙头" className="lg:col-span-2">
          <div className="flex flex-col gap-1 p-2">
            {themes.hot.slice(0, 8).map((r) => (
              <div key={r.name} className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="num shrink-0 text-xs text-up">{r.limitUp}涨停</span>
                </span>
                <span className="num shrink-0 text-[11px] text-muted">
                  均{(r.avg > 0 ? "+" : "")}{r.avg.toFixed(1)}% · 龙头 {r.leader?.name ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="主线强度" note="条长=相对强度">
          <div className="flex flex-col gap-1.5 p-2">
            {themes.hot.slice(0, 8).map((r) => {
              const max = Math.max(1, ...themes.hot.map((x) => x.limitUp));
              return (
                <div key={r.name} className="flex items-center gap-2">
                  <span className="w-20 truncate text-xs text-muted">{r.name}</span>
                  <span className="h-2 flex-1 rounded bg-surface2">
                    <span className="block h-2 rounded bg-up" style={{ width: `${(r.limitUp / max) * 100}%` }} />
                  </span>
                  <span className="num w-8 shrink-0 text-right text-xs">{r.limitUp}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* ── 主力资金动向：板块/个股流入流出 Top8（对标连板网）── */}
      <Panel title="主力资金动向" note={flow ? "板块/个股主力净额" : "资金流向还没拉到"} id="s-money">
        {!flow ? (
          <div className="px-3 py-4 text-sm text-muted">资金流向暂时拉不下来。</div>
        ) : (
          <div className="grid grid-cols-2 gap-2 p-2 lg:grid-cols-4">
            {[
              { title: "板块流入", rows: flow.sectorsIn.slice(0, 8) },
              { title: "板块流出", rows: flow.sectorsOut.slice(0, 8) },
              { title: "个股流入", rows: flow.stocksIn.slice(0, 8) },
              { title: "个股流出", rows: flow.stocksOut.slice(0, 8) },
            ].map((g) => (
              <div key={g.title}>
                <div className="mb-1 text-[11px] text-muted">{g.title}</div>
                <div className="flex flex-col gap-0.5">
                  {g.rows.map((r) => (
                    <div key={r.id} className="flex items-baseline justify-between gap-1 text-[12px]">
                      <button type="button" onClick={() => void openDetail(r.id)} className="truncate text-left hover:underline">{r.name}</button>
                      <span className={"num shrink-0 " + (r.inflow > 0 ? "text-up" : "text-down")}>
                        {(r.inflow / 10000).toFixed(1)}亿
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* ── 第一行 决策：温度计 + 时机判定 + 市场事实（系统状态降级到页尾）── */}
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,290px)_minmax(0,1fr)_minmax(0,1fr)]">
            <SentimentGauge reading={sentiment} updatedAt={stamp} />
            <Panel title="冰点沸点 · 是不是时机" note="前瞻判断 · 逐条标证据等级">
              <div className="flex flex-col gap-2 px-3.5 py-3 text-sm leading-relaxed">
                <div className="flex items-start gap-2">
                  <Tag tone="warn">沸点 · 已验证</Tag>
                  <span className="text-fg">追高连板已证伪：三连板+ 每笔 −3.71%，t=−10.19，六切片 6/6 全负。</span>
                </div>
                <div className="flex items-start gap-2">
                  <Tag tone="muted">冰点 · 待验证</Tag>
                  <span className="text-fg">缺情绪温度计历史序列，还不能说「冰点就是买点」。历史样本从今日起按日落盘。</span>
                </div>
                <div className="border-t border-line pt-2 text-xs text-muted">
                  当前档位：{sentiment?.band ?? "数据不足"}。只给情景概率与裁决点，不给买卖动作建议。
                </div>
              </div>
            </Panel>
            <Panel title="市场结论" note={stamp != null ? `更新于 ${new Date(stamp).toTimeString().slice(0, 5)}` : undefined}>
              <ul className="flex flex-col gap-2 px-3.5 py-3 text-sm leading-relaxed">
                {marketFacts.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand" aria-hidden />
                    <span className="text-fg">{f}</span>
                  </li>
                ))}
                {marketFacts.length === 0 ? <li className="text-muted">数据还没拉齐，拉齐了这里给事实清单。</li> : null}
              </ul>
            </Panel>
          </div>

      <Panel title="指数" note={stamp != null ? `更新于 ${new Date(stamp).toTimeString().slice(0, 5)}` : undefined}>
        <div className="flex overflow-x-auto scroll-slim">
          {indices.slice(0, 6).map((item) => (
            <div key={item.id} className="flex min-w-32 shrink-0 flex-col gap-0.5 border-r border-line px-3 py-2 last:border-r-0">
              <span className="truncate text-xs text-muted">{item.name}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="num text-sm font-medium">{item.price.toFixed(2)}</span>
                <span className={"num text-xs " + pctClass(item.pct)}>{item.pct > 0 ? "+" : ""}{item.pct.toFixed(2)}%</span>
              </span>
            </div>
          ))}
          {indices.length === 0 ? <div className="px-3 py-2 text-sm text-muted">指数暂时拉不下来</div> : null}
        </div>
      </Panel>

      <div className="grid gap-2">
        {/* 原来的「今日关键数字」已移到第三行「市场事实与资金」，这里只留放大的大盘分时。 */}
        <Panel title="大盘分时" note={indices[0] ? `${indices[0].name} ${indices[0].price.toFixed(2)}` : "指数暂时拉不下来"}>
          {trend && trend.points.length > 1 ? (
            <div className="h-[210px] px-2 py-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend.points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-up)" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="var(--color-up)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--color-muted)" }} tickLine={false} axisLine={false} minTickGap={48} />
                  <YAxis domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: "var(--color-muted)" }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => v.toFixed(2)} />
                  <Tooltip
                    contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: "var(--color-muted)" }}
                    formatter={(value) => [Number(value).toFixed(2), "点位"]}
                  />
                  {trend.prevClose != null ? <ReferenceLine y={trend.prevClose} stroke="var(--color-line)" strokeDasharray="3 3" /> : null}
                  <Area type="monotone" dataKey="price" stroke="var(--color-up)" strokeWidth={1.5} fill="url(#trend-fill)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[210px] items-center justify-center text-sm text-muted">分时数据暂时拉不下来</div>
          )}
        </Panel>
      </div>
        </div>

        {/* 右栏：效果图签名件——未读提醒 + 今日信号 */}
        <aside className="flex min-w-0 flex-col gap-2">
          <Panel title="今日信号" note={<Link to="/strategies/positions" className="text-accent hover:underline">全部持仓 →</Link>}>
            <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto scroll-slim p-2">
              {sellsToday.map((trade) => (
                <SignalRow key={`s-${trade.id}`} name={trade.name} side="卖出" price={trade.exit} pnl={(trade.exit! / trade.entry - 1) * 100} />
              ))}
              {buysToday.map((trade) => {
                const quote = priceOf(trade.id);
                return (
                  <SignalRow
                    key={`b-${trade.id}`}
                    name={trade.name}
                    side="买入"
                    price={trade.entry}
                    hint={quote?.chg != null ? `现价 ${quote.price.toFixed(2)}（${quote.chg > 0 ? "+" : ""}${quote.chg.toFixed(2)}%）` : undefined}
                  />
                );
              })}
              {buysToday.length === 0 && sellsToday.length === 0 ? (
                <div className="px-2 py-6 text-center text-sm text-muted">
                  {date ? "今天还没有信号" : "非交易日"}
                </div>
              ) : null}
            </div>
          </Panel>

        </aside>
      </div>

      {/* ── 第二行 盘面：具体个股连板 / 热门概念 / 下一个可能热门 ── */}
      <div className="grid gap-2 lg:grid-cols-3">
        <Panel title="连板梯队" note={poolFresh ?? "今天还没采集"}>
          {!poolSnap ? (
            <div className="px-3 py-6 text-sm text-muted">{pools.why ?? "三池快照还没落盘，收盘后 15:12 采集"}</div>
          ) : (
            <div className="flex max-h-[460px] flex-col gap-1.5 overflow-y-auto scroll-slim p-2">
              {/* 梯队汇总：几板有几只，一眼看清 */}
              <div className="flex flex-wrap gap-1">
                {ladderGroups.map((g) => (
                  <Tag key={g.streak} tone={g.streak >= 3 ? "up" : "muted"}>
                    {g.streak === 1 ? "首板" : `${g.streak}连板`} {g.rows.length}
                  </Tag>
                ))}
              </div>
              {/* 分组明细：按连板数从高到低，全量不截断 */}
              {ladderGroups.map((g) => (
                <div key={g.streak} className="flex flex-col gap-0.5">
                  <div className="px-2 text-[11px] text-muted">
                    {g.streak === 1 ? "首板" : `${g.streak} 连板`}（{g.rows.length}）
                  </div>
                  {g.rows.map((r) => {
                    const concept = reasons[r.code]?.primary_concept ?? r.industry ?? "";
                    const isPureStreak = r.stat === `${r.streak}天${r.streak}板`;
                    return (
                      <div key={r.id} className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <button type="button" onClick={() => void openDetail(r.id)} className="truncate text-left font-medium hover:underline">{r.name}</button>
                          {r.stat && !isPureStreak ? (
                            <span className="num shrink-0 rounded bg-surface2 px-1 text-[10px] text-warn">{r.stat}</span>
                          ) : null}
                        </span>
                        <span className="num shrink-0 text-[11px] text-muted">
                          {r.sealFund ? `${(r.sealFund / 10000).toFixed(0)}万` : "—"} · 开板{r.breaks ?? 0}
                        </span>
                        {concept ? (
                          <span className="shrink-0 rounded bg-brand-soft px-1 text-[10px] text-brand-text">{concept}</span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {/* 炸板：全量 */}
              {brokenRows.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  <div className="px-2 text-[11px] text-muted">炸板（{brokenRows.length}）</div>
                  {brokenRows.map((r) => (
                    <div key={`b-${r.id}`} className="flex items-baseline justify-between gap-2 rounded px-2 py-0.5 text-sm hover:bg-surface-2">
                      <span className="truncate">{r.name}</span>
                      <span className={"num shrink-0 text-xs " + pctClass(r.pct)}>{r.pct > 0 ? "+" : ""}{r.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {ladderGroups.length === 0 && brokenRows.length === 0 ? (
                <div className="px-2 py-5 text-center text-sm text-muted">
                  {poolSnap.why ?? "快照里没有个股明细，不拿全 0 冒充「今天没涨停」"}
                </div>
              ) : null}
              <div className="border-t border-line px-2 pt-2 text-[11px] leading-snug text-muted">
                {poolSnap.limitUp.length} 只涨停 · {poolSnap.broken.length} 只炸板 · {poolSnap.limitDown.length} 只跌停 ·
                炸板率 {poolSnap.summary?.breakRate != null ? `${(poolSnap.summary.breakRate * 100).toFixed(0)}%` : "—"}
                {poolSnap.sealed ? "" : " · 盘中未定"}
              </div>
            </div>
          )}
        </Panel>

        <Panel title="热门概念" note={themes.date ? `${themes.date} 收盘后` : "今天还没生成"}>
          {hotThemes.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted">题材热度榜还没生成，theme-heat.ts 每天 15:10 跑。</div>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {hotThemes.map((r) => {
                const c = continuationOf(r);
                return (
                  <div key={r.name} className="rounded px-2 py-1.5 hover:bg-surface-2">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">{r.name}</span>
                      <span className="num shrink-0 text-up">{r.limitUp} 只涨停</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                      <span className="truncate">均 {r.avg > 0 ? "+" : ""}{r.avg.toFixed(1)}% · 龙头 {r.leader?.name ?? "—"}</span>
                      <Tag tone={c.evidence === "已验证" ? "up" : c.evidence === "噪声级" ? "warn" : "muted"}>{c.evidence}</Tag>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="border-t border-line px-2 py-2 text-right text-xs">
            <Link to="/review/theme" className="text-accent hover:underline">完整题材榜 →</Link>
          </div>
        </Panel>

        <Panel title="下一个可能热门" note="前瞻观察 · 情景概率 · 非买入信号">
          <div className="flex flex-col gap-1.5 p-2">
            <div className="text-[11px] text-muted">概念延续性（每条标证据等级）</div>
            {hotThemes.slice(0, 2).map((r) => {
              const c = continuationOf(r);
              return (
                <div key={`c-${r.name}`} className="rounded px-2 py-1.5 hover:bg-surface-2">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate">{r.name}</span>
                    <Tag tone={c.tone === "up" ? "up" : c.tone === "warn" ? "warn" : "muted"}>{c.evidence}</Tag>
                  </div>
                  <div className="text-[11px] leading-snug text-muted">{c.label} · {c.basis}</div>
                </div>
              );
            })}
            {hotThemes.length === 0 ? <div className="px-2 py-3 text-sm text-muted">题材数据没来，观察也就不给。</div> : null}
            <div className="border-t border-line pt-2 text-[11px] text-muted">
              题材补涨候选 · {shortSignals.length} 只 · {LAGGARD_EVIDENCE.level}
            </div>
            {shortSignals.map((s) => (
              <div key={`s-${s.id}`} className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">{s.name}</span>
                  <span className="truncate text-[11px] text-muted">{s.reason}</span>
                </span>
                <Tag tone={s.verdict === "ok" ? "up" : "warn"}>{s.verdict === "ok" ? "通过" : "提醒"}</Tag>
              </div>
            ))}
            {shortSignals.length === 0 ? <div className="px-2 py-3 text-sm text-muted">今天没有题材补涨候选。</div> : null}
            <div className="border-t border-line pt-2 text-[11px] leading-snug text-muted">
              {LAGGARD_EVIDENCE.basis}。只作观察名单，不作买入信号。
            </div>
          </div>
        </Panel>
      </div>

      {/* ── 第三行 个股：今日盘前候选（数据复述，不是买入推荐）── */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel
          title="今日盘前候选 · 预登记策略筛出"
          note={reviewed.date ? `${reviewed.date} · ${candidateCount} 个 / 通过 ${reviewed.ok} · 提醒 ${reviewed.warn}` : "今天还没审核"}
        >
          {longSignals.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted">盘前审核还没生成候选，9:26 后才有。</div>
          ) : (
            <div className="flex flex-col gap-0.5 p-2">
              {longSignals.map((s) => (
                <div key={`l-${s.id}`} className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">{s.name}</span>
                    <span className="truncate text-[11px] text-muted">{s.reason}</span>
                  </span>
                  <span className="num shrink-0 text-xs text-muted">{s.buyPrice.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-line px-2 py-2 text-[11px] leading-snug text-muted">
            数据复述，不是买入推荐。短线腿见上方「下一个可能热门」，审核结论与预登记参数在
            <Link to="/strategies/positions" className="text-accent hover:underline"> 持仓页 </Link>。
          </div>
        </Panel>
        <Panel title="市场事实与资金" note={breadth ? `全市场 ${breadth.up + breadth.down + breadth.flat} 只` : undefined}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 p-3">
            <KeyNum label="上涨 / 下跌" value={breadth ? `${breadth.up} / ${breadth.down}` : null} hint={breadth ? `平盘 ${breadth.flat}` : "涨跌家数暂不可用"} />
            <KeyNum label="涨停 / 跌停" value={breadth ? `${breadth.limitUp} / ${breadth.limitDown}` : null} hint="涨跌停是情绪极值" />
            <KeyNum label="两市成交额" value={tapeAmount != null ? yi(tapeAmount) : null} hint={prevTape ? `昨日 ${yi(prevTape)}` : "成交额暂不可用"} />
            <KeyNum
              label="主力净流入 · 全市场"
              value={mainInflow == null ? null : yi(mainInflow)}
              tone={mainInflow == null ? undefined : mainInflow > 0 ? "text-up" : mainInflow < 0 ? "text-down" : undefined}
              hint={flow ? `数据 ${new Date(flow.asOf).toTimeString().slice(0, 5)}` : "资金流向暂不可用"}
            />
          </div>
        </Panel>
      </div>

      {/* ── Zone B 资金与结构 ── */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="资金快照" note={flow ? `数据 ${new Date(flow.asOf).toTimeString().slice(0, 5)}` : "资金流向暂不可用"}>
          <div className="grid grid-cols-1 gap-x-3 p-3 sm:grid-cols-3">
            <KeyNum
              label="主力净额 · 全市场"
              value={mainInflow == null ? null : yi(mainInflow)}
              tone={mainInflow == null ? undefined : mainInflow > 0 ? "text-up" : mainInflow < 0 ? "text-down" : undefined}
              hint="主力 = 超大单 + 大单"
            />
            <KeyNum
              label="北向成交额"
              value={northAmount != null ? yi(northAmount) : null}
              hint="沪深股通双腿合计；净流入自 2024-08 起不再公布"
            />
            <KeyNum
              label="两市成交额"
              value={tapeAmount != null ? yi(tapeAmount) : null}
              hint={prevTape ? `昨日 ${yi(prevTape)}${tapeAmount != null && prevTape ? `（${tapeAmount >= prevTape ? "+" : ""}${(((tapeAmount - prevTape) / prevTape) * 100).toFixed(1)}%）` : ""}` : undefined}
            />
          </div>
        </Panel>

        <Panel title="行业主力净流入 TOP5" note={<Link to="/review/flow" className="text-accent hover:underline">资金流向 →</Link>}>
          <div className="flex flex-col gap-1 p-2">
            {flow
              ? [...flow.sectorsIn.slice(0, 5).map((row) => ({ row, side: 1 as const })),
                 ...flow.sectorsOut.slice(0, 5).map((row) => ({ row, side: -1 as const }))]
                  .sort((a, b) => Math.abs(b.row.inflow) - Math.abs(a.row.inflow))
                  .slice(0, 8)
                  .map(({ row, side }) => (
                    <div key={row.id + side} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={side > 0 ? "h-full bg-up" : "h-full bg-down"}
                          style={{ width: `${Math.min(100, (Math.abs(row.inflow) / 10_000 / Math.max(1, ...flow.sectorsIn.slice(0, 5).map((r) => Math.abs(r.inflow) / 10_000))) * 100).toFixed(0)}%` }}
                        />
                      </div>
                      <span className={"num w-20 shrink-0 text-right " + (side > 0 ? "text-up" : "text-down")}>
                        {side > 0 ? "+" : ""}{(row.inflow / 10_000).toFixed(1)} 亿
                      </span>
                    </div>
                  ))
              : <div className="py-6 text-center text-sm text-muted">资金流向暂时拉不下来</div>}
            {flow && flow.sectorsIn.length === 0 ? <div className="py-6 text-center text-sm text-muted">今天没有行业资金数据</div> : null}
          </div>
        </Panel>
      </div>

      {/* ── Zone C 全球对照 + 产品状态 ── */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="全球市场" note={<Link to="/overseas" search={{ tab: "indices", market: "hk", page: 1, sort: "chg" }} className="text-accent hover:underline">全部行情 →</Link>}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 sm:grid-cols-3">
            {overseas.map((item) => (
              <KeyNum
                key={item.id}
                label={item.name}
                value={item.price != null ? item.price.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : null}
                tone={item.chg != null ? (item.chg > 0 ? "text-up" : item.chg < 0 ? "text-down" : undefined) : undefined}
                hint={item.chg != null ? `${item.chg > 0 ? "+" : ""}${item.chg.toFixed(2)}%` : "休市/暂无新价"}
              />
            ))}
            {overseas.length === 0 ? (
              <div className="col-span-full py-4 text-center text-sm text-muted">
                {overseasGaps[0] ?? "全球市场行情暂不可用"}
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="产品与进化状态" note={recorderDead ? <span className="text-warn">记账异常</span> : "系统正常"}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 p-3">
            <KeyNum
              label="上次记账"
              value={recorderDead ? "中断" : "正常"}
              tone={recorderDead ? "text-warn" : "text-down"}
              hint={recorder.at ? `更新于 ${new Date(recorder.at).toTimeString().slice(0, 5)}` : "心跳丢失"}
            />
            <KeyNum
              label="今日开 / 平仓"
              value={`${buysToday.length} / ${sellsToday.length}`}
              hint={`追踪中策略 ${styles.length} 套 · 持仓 ${openTrades.length} 只`}
            />
            <KeyNum
              label="在跑挑战者"
              value={runningChallengers.length}
              suffix="个"
              hint={
                runningChallengers.length
                  ? runningChallengers
                      .slice(0, 2)
                      .map((c) => `${c.id} ${challengerSamples[c.id]?.n ?? 0}/${challengerSamples[c.id]?.target ?? 30}`)
                      .join(" · ") + (runningChallengers.length > 2 ? ` 等` : "")
                  : "进化闭环在空转"
              }
            />
            <KeyNum
              label="持仓策略"
              value={styles.length}
              suffix="套"
              hint={
                journal.why ??
                (styles.some((st) => !(ACTIVE_STYLES as string[]).includes(st))
                  ? "含已下线策略的历史仓（结算到清，不再开新）"
                  : undefined)
              }
            />
          </div>
          {/* 挑战者进化进度：效果图「总览」里的进度卡，用真实样本数 / 目标数画条。
              没在跑的挑战者整段不显示——空转时不编「0/30 进度」。 */}
          {runningChallengers.length > 0 ? (
            <div className="border-t border-line px-3 pb-3 pt-3">
              <div className="mb-2 text-xs font-medium text-muted">挑战者进化进度</div>
              <div className="flex flex-col gap-2">
                {runningChallengers.slice(0, 4).map((c) => {
                  const s = challengerSamples[c.id];
                  const n = s?.n ?? 0;
                  const target = s?.target ?? 30;
                  return (
                    <div key={c.id}>
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-fg">{c.name}</span>
                        <span className="num text-muted">{n}/{target}</span>
                      </div>
                      <Prog value={n / target} className="mt-1" />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </Panel>
      </div>

      {/* ── Zone D 轻量延伸（今日信号已上右栏，这里只留快讯）── */}
      <div className="grid gap-2">
        <Panel title="热点快讯" note={<Link to="/news" className="text-accent hover:underline">全部资讯 →</Link>}>
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto scroll-slim p-2">
            {news.map((item) => (
              <div key={item.id} className="flex items-baseline gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 self-center rounded-full"
                  style={{ background: item.tone === "good" ? "var(--color-up)" : item.tone === "bad" ? "var(--color-down)" : "var(--color-muted)" }}
                  aria-label={item.tone === "good" ? "利好" : item.tone === "bad" ? "利空" : "中性"}
                />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="num shrink-0 text-xs text-muted">{item.time}</span>
              </div>
            ))}
            {news.length === 0 ? <div className="px-2 py-6 text-center text-sm text-muted">快讯暂不可用</div> : null}
          </div>
        </Panel>
      </div>

      {/* ── 第四行尾 项目情况：系统状态从原先的页首降级到这里 ── */}
      <div className="grid gap-2 sm:grid-cols-3">
        <HeroStat
          icon={<ShieldCheck size={18} />}
          label="系统健康"
          value={String(healthScore)}
          suffix="/ 100"
          tone={healthScore === 100 ? "ok" : "warn"}
          sub={
            healthScore === 100
              ? "记账 · 行情 · 闸门 · 指数 四项都在"
              : `缺：${checks.filter((c) => !c.ok).map((c) => c.label).join("、")}`
          }
        />
        <HeroStat
          icon={<Clock size={18} />}
          label="行情延迟"
          value={delaySec != null ? `${delaySec} 秒` : "—"}
          tone={delaySec == null ? "muted" : delaySec < 120 ? "ok" : "warn"}
          sub={universe?.asOf ? `更新于 ${new Date(universe.asOf).toTimeString().slice(0, 5)}` : "行情还没拉到"}
        />
        <HeroStat
          icon={<Gauge size={18} />}
          label="风控闸门"
          value={gatesOff === 0 ? "正常" : `${gatesOff} 套停用`}
          tone={gatesOff === 0 ? "ok" : "warn"}
          sub={gatesOff === 0 ? "未触发熔断，策略按预登记规则记账" : "停用名单见策略页，冷却后复跑判决"}
        />
      </div>
    </Frame>
    {modal}
    </>
  );
}

/** 关键数字格：label + 大数字 + 口径 hint。value 为 null 显示 ——（拉不到）。 */
function KeyNum({
  label,
  value,
  suffix,
  tone,
  hint,
}: {
  label: string;
  value: number | string | null;
  suffix?: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={"num mt-0.5 text-lg font-medium " + (tone ?? "text-fg")}>
        {value ?? "—"}
        {suffix ? <span className="ml-1 text-xs font-normal text-muted">{suffix}</span> : null}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</div> : null}
    </div>
  );
}

/** 今日信号的一行。side 决定标签色：红买绿卖只是标签约定，盈亏另算。 */
function SignalRow({
  name,
  side,
  price,
  pnl,
  hint,
}: {
  name: string;
  side: "买入" | "卖出";
  price: number | null;
  /** 卖出时给：相对买入价的盈亏百分比 */
  pnl?: number;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2">
      <span className="flex min-w-0 items-baseline gap-2">
        <Tag tone={side === "买入" ? "up" : "down"}>{side}</Tag>
        <span className="truncate">{name}</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-2 text-xs">
        {price != null ? <span className="num text-muted">{(price).toFixed(2)}</span> : null}
        {pnl != null ? <span className={"num " + pctClass(pnl)}>{pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%</span> : null}
        {hint ? <span className="text-muted">{hint}</span> : null}
      </span>
    </div>
  );
}
