/**
 * 这个文件是干什么的：
 * 总览首页（《赤轨 UI 升级方案 2026-10》首页 Zone A–D，直接替换旧主控台）。
 * 目标：30 秒看懂「市场怎么样 + 系统正不正常」，全站第一屏的成品感在这页立住。
 *
 * 分区：
 * - Zone A 市场核心：指数条 + 情绪温度计（签名组件）+ 今日关键数字 + 大盘分时
 * - Zone B 资金与结构：资金快照三格 + 行业资金 Top5 双色条
 * - Zone C 全球对照 + 产品状态：全球指数迷你列表 + 服务/开平仓/挑战者进度
 * - Zone D 轻量延伸：今日信号 + 热点快讯
 *
 * 纪律：
 * - 全部复用现成接口，任何一块拉失败都降级成说明，不造假数。
 * - 全市场快照照旧在 loader 里瘦身（~5300 只进 SSR HTML 会把手机端卡死），
 *   涨跌家数用现成的 getBreadth（服务端算好，不塞全量快照给浏览器）。
 * - 不放任何买卖建议。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, pctClass } from "@/components/terminal";
import { SentimentGauge } from "@/components/sentiment-gauge";
import { sessionPhase } from "@/lib/market/session";
import { journalTradeIds, slimUniverse as slimUniverseByIds } from "@/lib/market/slim-universe";
import { computeSentiment } from "@/lib/market/sentiment";
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
  getTrend,
  getUniverse,
} from "@/lib/market/quotes.functions";
import { getOverseasIndices } from "@/lib/market/overseas-list.functions";

/** 首页要的数据一次取齐。任何一块拉失败都降级成空，不让整页打不开。 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const phase = sessionPhase();
    const [indices, journal, universe, recorder, flow, breadth, challengers, samples, overseas, news] =
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
      ]);
    // 大盘分时用第一只指数画（getTrend 只认常用指数白名单，索引行情出来的 id 一定在）。
    const trend = indices[0]
      ? await getTrend({ data: { id: indices[0].id } }).catch(() => null)
      : null;
    // 全市场快照 ~5300 只、进 SSR HTML 有 1.2MB，手机端解析时会卡到点不动。
    // 首页只用持仓相关的几只（priceOf 按 id 查现价/涨跌），先按账本 id 瘦身再返回。
    const slimUniverse = slimUniverseByIds(universe, journalTradeIds(journal));
    // 情绪温度计在服务端算好（分量全是上面的真实数据，计算本身在 lib 里有测试钉着）。
    const sentiment = breadth
      ? computeSentiment(
          breadth,
          indices.map((item) => item.pct),
          flow ? flow.market.reduce((total, part) => total + part.main, 0) : null,
        )
      : null;
    // 数据时间脚注：指数行情的时间戳最可靠；没有就标未知。
    const stamp =
      phase.date && indices[0]?.time
        ? new Date(`${phase.date}T${indices[0].time}`).getTime()
        : null;
    return {
      phase, indices, journal, universe: slimUniverse, recorder, trend, flow,
      breadth, sentiment, stamp,
      runningChallengers: challengers.list.filter((c) => c.status === "running"),
      challengerSamples: samples,
      overseas: overseas.quotes.slice(0, 6),
      overseasGaps: overseas.gaps,
      news: news.slice(0, 6),
    };
  },
  component: Dashboard,
});

const STYLE_LABEL: Record<string, string> = {
  early: "启动",
  trend: "趋势",
  breakout: "突破",
  value: "价值",
  relay: "补涨",
  rebound: "反弹",
};

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
    breadth, sentiment, stamp,
    runningChallengers, challengerSamples, overseas, overseasGaps, news,
  } = Route.useLoaderData();
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
  const recorderDead = recorder.at == null || Date.now() - recorder.at > 3 * 60_000;

  return (
    <Frame
      wide
      status={{
        label: "今日信号",
        value: `${buysToday.length + sellsToday.length} 条`,
        tone: buysToday.length + sellsToday.length > 0 ? "brand" : "neutral",
      }}
    >
      {/* ── Zone A 市场核心状态 ── */}
      <h1 className="font-display text-xl font-medium tracking-wide">总览</h1>

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

      <div className="grid gap-2 lg:grid-cols-[230px_minmax(0,1.35fr)_minmax(0,1fr)]">
        <Panel title="今日关键数字" note={breadth ? `全市场 ${breadth.up + breadth.down + breadth.flat} 只` : undefined}>
          <div className="flex flex-col gap-2.5 p-3">
            <KeyNum
              label="上涨 / 下跌"
              value={breadth ? `${breadth.up} / ${breadth.down}` : null}
              hint={breadth ? `平盘 ${breadth.flat}` : "涨跌家数暂不可用"}
            />
            <KeyNum
              label="涨停 / 跌停"
              value={breadth ? `${breadth.limitUp} / ${breadth.limitDown}` : null}
              hint="涨跌停是情绪极值"
            />
            <KeyNum
              label="两市成交额"
              value={tapeAmount != null ? yi(tapeAmount) : null}
              hint={prevTape ? `昨日 ${yi(prevTape)}` : "成交额暂不可用"}
            />
            <KeyNum
              label="主力净流入 · 全市场"
              value={mainInflow == null ? null : yi(mainInflow)}
              tone={mainInflow == null ? undefined : mainInflow > 0 ? "text-up" : mainInflow < 0 ? "text-down" : undefined}
              hint={flow ? `数据 ${new Date(flow.asOf).toTimeString().slice(0, 5)}` : "资金流向暂不可用"}
            />
          </div>
        </Panel>

        <SentimentGauge reading={sentiment} updatedAt={stamp} />

        <Panel title="大盘分时" note={indices[0] ? `${indices[0].name} ${indices[0].price.toFixed(2)}` : "指数暂时拉不下来"}>
          {trend && trend.points.length > 1 ? (
            <div className="h-[150px] px-2 py-2">
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
            <div className="flex h-[150px] items-center justify-center text-sm text-muted">分时数据暂时拉不下来</div>
          )}
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
              label="记账心跳"
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
              hint={journal.why ?? undefined}
            />
          </div>
        </Panel>
      </div>

      {/* ── Zone D 轻量延伸 ── */}
      <div className="grid gap-2 lg:grid-cols-2">
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
    </Frame>
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
