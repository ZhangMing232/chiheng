/**
 * 这个文件是干什么的：
 * 主控台——每天打开的第一页（《赤轨 UI 重设计方案》里的 01 工作台）。
 * 一屏看完：今日信号、追踪中的策略、大盘分时、行业资金，全部用真账真行情，
 * 数字造不出来就不放（设计稿里的演示数字一律不抄）。
 *
 * 你需要知道的：
 * - 数据来自五个现成接口：指数、账本、资金流向、行情名单、记账心跳。
 * - 资金流向拉不下来时那一块显示说明，不造假数。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, pctClass } from "@/components/terminal";
import { sessionPhase } from "@/lib/market/session";
import { journalTradeIds, slimUniverse as slimUniverseByIds } from "@/lib/market/slim-universe";
import type { IndexQuote, Quote, SessionInfo } from "@/lib/market/types";
import type { PaperDay } from "@/lib/paper";
import type { FlowBook } from "@/lib/market/flow";
import {
  getFlow,
  getIndices,
  getRecorder,
  getServerJournal,
  getTrend,
  getUniverse,
} from "@/lib/market/quotes.functions";

/** 主控台要的数据一次取齐。任何一块拉失败都降级成空，不让整页打不开。 */
export const Route = createFileRoute("/")({
  loader: async () => {
    const phase = sessionPhase();
    const [indices, journal, universe, recorder, flow] = await Promise.all([
      getIndices().catch(() => [] as IndexQuote[]),
      getServerJournal().catch(() => ({ days: [] as PaperDay[], personal: false, why: "账本暂时读不到" })),
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getRecorder().catch(() => ({ at: null, ok: false })),
      getFlow().catch(() => null as FlowBook | null),
    ]);
    // 大盘分时用第一只指数画（getTrend 只认常用指数白名单，索引行情出来的 id 一定在）。
    const trend = indices[0]
      ? await getTrend({ data: { id: indices[0].id } }).catch(() => null)
      : null;
    // 全市场快照 ~5300 只、进 SSR HTML 有 1.2MB，手机端解析时会卡到点不动。
    // 首页只用持仓相关的几只（priceOf 按 id 查现价/涨跌），先按账本 id 瘦身再返回。
    const slimUniverse = slimUniverseByIds(universe, journalTradeIds(journal));
    return { phase, indices, journal, universe: slimUniverse, recorder, trend, flow };
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

function Dashboard() {
  const { phase, indices, journal, universe, recorder, trend, flow } = Route.useLoaderData();
  const date = todayStr(phase);
  // 账本按天、新的在前；今天那天的信号是「今日新增」
  const todayDay = journal.days.find((day) => day.date === date) ?? null;
  const buysToday = todayDay?.trades ?? [];
  // 今天卖出的散落在所有历史天里（exitDate 是卖出那天）
  const sellsToday = journal.days.flatMap((day) =>
    day.trades.filter((trade) => trade.exit != null && trade.exitDate === date),
  );
  // 手上还持有的（跨所有天），按策略分组
  const openTrades = journal.days.flatMap((day) => day.trades.filter((trade) => trade.exit == null));
  const styles = [...new Set(openTrades.map((trade) => trade.style ?? "other"))];
  const priceOf = (id: string): Quote | null => universe?.quotes.find((quote) => quote.id === id) ?? null;
  const mainInflow = flow ? flow.market.reduce((total, part) => total + part.main, 0) : null;
  const recorderDead = recorder.at == null || Date.now() - recorder.at > 3 * 60_000;

  return (
    <Frame wide>
      {/* 第一行：四张 KPI 卡（PPT：1:4，h 88-92） */}
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        <Kpi label="今日新增信号" value={buysToday.length + sellsToday.length}>
          买入 {buysToday.length} · 卖出 {sellsToday.length}
        </Kpi>
        <Kpi label="追踪中策略" value={styles.length} suffix="套">
          持仓 {openTrades.length} 只
        </Kpi>
        <Kpi label="主力净流入 · 全市场" value={mainInflow == null ? null : (mainInflow / 10_000).toFixed(1)} suffix="亿" tone={mainInflow == null ? undefined : mainInflow > 0 ? "text-up" : mainInflow < 0 ? "text-down" : undefined}>
          {flow ? `数据 ${new Date(flow.asOf).toTimeString().slice(0, 5)}` : "资金流向暂时拉不下来"}
        </Kpi>
        <Kpi
          label="记账状态"
          value={recorderDead ? "中断" : "正常"}
          tone={recorderDead ? "text-warn" : "text-down"}
        >
          {recorder.at ? `更新于 ${new Date(recorder.at).toTimeString().slice(0, 5)}` : "心跳丢失"}
        </Kpi>
      </div>

      {/* 第二行：大盘分时（左 2/3）+ 今日信号（右 1/3） */}
      <div className="grid gap-2 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="大盘分时"
          note={indices[0] ? `${indices[0].name} ${indices[0].price.toFixed(2)}` : "指数暂时拉不下来"}
        >
          {trend && trend.points.length > 1 ? (
            <div className="h-64 px-2 py-2">
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
            <div className="flex h-64 items-center justify-center text-sm text-muted">分时数据暂时拉不下来</div>
          )}
        </Panel>

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
      </div>

      {/* 第三行：策略表现（左）+ 行业资金（右） */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="追踪中策略" note={<Link to="/strategies/positions" className="text-accent hover:underline">策略追踪 →</Link>}>
          <table className="w-full text-sm">
            <caption className="sr-only">各策略持仓与今日新进</caption>
            <thead>
              <tr className="text-xs text-muted">
                <th className="px-2.5 py-1.5 text-left font-normal">策略</th>
                <th className="px-2.5 py-1.5 text-right font-normal">持仓</th>
                <th className="px-2.5 py-1.5 text-right font-normal">今日新进</th>
                <th className="px-2.5 py-1.5 text-right font-normal">距止损空间</th>
              </tr>
            </thead>
            <tbody>
              {styles.map((style) => {
                const held = openTrades.filter((trade) => (trade.style ?? "other") === style);
                const fresh = buysToday.filter((trade) => (trade.style ?? "other") === style);
                const rooms = held
                  .map((trade) => {
                    const quote = priceOf(trade.id);
                    if (!quote || trade.stop == null || trade.stop === 0) return null;
                    return ((quote.price - trade.stop) / trade.stop) * 100;
                  })
                  .filter((value): value is number => value != null);
                const avgRoom = rooms.length ? rooms.reduce((a, b) => a + b, 0) / rooms.length : null;
                return (
                  <tr key={style} className="border-t border-line">
                    <td className="px-2.5 py-1.5">{STYLE_LABEL[style] ?? style}</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{held.length} 只</td>
                    <td className="px-2.5 py-1.5 text-right tabular-nums">{fresh.length} 只</td>
                    <td className={"px-2.5 py-1.5 text-right tabular-nums " + (avgRoom == null ? "text-muted" : pctClass(-avgRoom))}>
                      {avgRoom == null ? "—" : `${avgRoom.toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
              {styles.length === 0 ? (
                <tr><td colSpan={4} className="px-2.5 py-6 text-center text-muted">持仓为空，去策略选股页跑一轮</td></tr>
              ) : null}
            </tbody>
          </table>
        </Panel>

        <Panel title="行业主力净流入 TOP6" note={<Link to="/flow" className="text-accent hover:underline">资金流向 →</Link>}>
          <div className="flex flex-col gap-1 p-2">
            {(flow?.sectorsIn ?? []).slice(0, 6).map((row) => (
              <div key={row.id} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{row.name}</span>
                <span className="shrink-0 tabular-nums text-up">+{(row.inflow / 10_000).toFixed(1)} 亿</span>
              </div>
            ))}
            {flow == null ? <div className="py-6 text-center text-sm text-muted">资金流向暂时拉不下来</div> : null}
            {flow && flow.sectorsIn.length === 0 ? <div className="py-6 text-center text-sm text-muted">今天没有行业流入数据</div> : null}
          </div>
        </Panel>
      </div>

      {/* 指数横带（PPT：行情是一条横带，余光扫红绿） */}
      <Panel title="指数">
        <div className="flex overflow-x-auto scroll-slim">
          {indices.map((item) => (
            <div key={item.id} className="flex min-w-32 shrink-0 flex-col gap-0.5 border-r border-line px-3 py-2 last:border-r-0">
              <span className="truncate text-xs text-muted">{item.name}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-sm font-medium tabular-nums">{item.price.toFixed(2)}</span>
                <span className={"text-xs tabular-nums " + pctClass(item.pct)}>{item.pct > 0 ? "+" : ""}{item.pct.toFixed(2)}%</span>
              </span>
            </div>
          ))}
          {indices.length === 0 ? <div className="px-3 py-2 text-sm text-muted">指数暂时拉不下来</div> : null}
        </div>
      </Panel>

      {/* AI 控制台（UI-STANDARD v1.1 U5，学 Vibe-Research 的示例卡入口）：
          每张卡对应 /ai 上一个真实动作，带锚点跳过去。不做假对话输入——
          赤轨的 AI 是它提议、闸门说了算的闭环，入口只指真实能力。
          视觉学 Vibe-Research 首页那张「今天想研究什么」大卡：全站唯一一处
          大面积品牌垫底，白卡浮在上面；正文其余区域仍是中性灰。 */}
      <section className="rounded border border-line bg-brand-soft px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-4 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
          <h2 className="text-base font-medium">今天，想让 AI 做什么？</h2>
          <Link to="/ai" className="ml-auto shrink-0 text-xs text-accent hover:underline">
            全部 AI 管理 →
          </Link>
        </div>
        <p className="mt-1 text-xs text-muted">
          AI 只提议，6 关检验和挑战者判决说了算；进化闭环每晚自动跑，早上看下场。
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {AI_CARDS.map((card) => (
            <Link
              key={card.to}
              to={card.to}
              className="rounded border border-line bg-surface px-3 py-2.5 transition hover:bg-surface-2"
            >
              <div className="text-sm font-medium">{card.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{card.hint}</p>
            </Link>
          ))}
        </div>
      </section>
    </Frame>
  );
}

/** 首页 AI 控制台的示例卡。to 必须是真实子页地址——AI 管理 2026-10-21 拆成
 *  真实子页（/ai、/ai/config、/ai/usage），待验队列在因子页，这里指过去。 */
const AI_CARDS = [
  { to: "/ai", title: "跑一轮进化", hint: "AI 提议新因子/新参数，6 关和挑战者判决说了算，下一轮自动读到这轮的下场" },
  { to: "/factors", title: "待验队列", hint: "AI 提的假设排队进 6 关检验，连续 2 次不过自动淘汰" },
  { to: "/ai/usage", title: "Token 用量", hint: "每次调 AI 的 tokens、耗时、成败、哪条链路烧的，全记账" },
  { to: "/ai/config", title: "接口配置", hint: "多套 API 档案并存，启用一套跑所有闭环；key 只回尾号" },
] as const;

/** KPI 卡。value 为 null 显示 ——（拉不到），hint 行放口径说明。 */
function Kpi({
  label,
  value,
  suffix,
  tone,
  children,
}: {
  label: string;
  value: number | string | null;
  suffix?: string;
  tone?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded border border-line bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={"mt-1 text-2xl font-medium tabular-nums " + (tone ?? "text-fg")}>
        {value ?? "—"}
        {suffix ? <span className="ml-1 text-xs font-normal text-muted">{suffix}</span> : null}
      </div>
      <div className="mt-0.5 text-xs text-muted">{children}</div>
    </div>
  );
}

/** 今日信号的一行。side 决定颜色：A 股约定红买绿卖只是标签色，盈亏另算。 */
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
        {price != null ? <span className="tabular-nums text-muted">{(price).toFixed(2)}</span> : null}
        {pnl != null ? <span className={"tabular-nums " + pctClass(pnl)}>{pnl > 0 ? "+" : ""}{pnl.toFixed(2)}%</span> : null}
        {hint ? <span className="text-muted">{hint}</span> : null}
      </span>
    </div>
  );
}
