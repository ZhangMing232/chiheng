/**
 * 这个文件是干什么的：
 * 「资金流向」区（/flow 下）各子页面共用的展示组件和二级 tab 定义。
 * 2026-10-21 用户要求：原来资金流向一页内的滚动锚点（概览/走势/大盘资金/北向/
 * 行业/个股/游资/收盘快照/两融/期指）全部改成真实子页面，不再无限下滑。
 * 这里是从 routes/flow/index.tsx 拆出来的纯展示部分，每个子页只带自己要的块。
 *
 * 你需要知道的：
 * - 本文件不含任何 loader 和路由——数据在各子页的 loader 里拉，组件只负责画。
 * - FlowSectionTabs 是这一区统一的二级 tab（11 个子页），子页顶部挂同一个组件，
 *   增删子页只改这一处。
 * - 数据口径的说明（主力不是机构、北向没有盘中净流入等）留在各块的 hint 里，
 *   拆页不改口径。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { StockName } from "@/components/screener/stock-name";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import * as echarts from "echarts";
import { SectionTabs } from "@/components/section-tabs";
import { Table, tdClass, thClass } from "@/components/terminal";
import { fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { readMarket, type FlowRow, type MarketPart, type NorthLeg } from "@/lib/market/flow";
import type { MarginRow } from "@/lib/market/margin";
import { GapList } from "@/components/source-line";
import type { FutBook } from "@/lib/market/index-futures";
import { minuteCandles, hhmm } from "@/lib/market/minute-candles";
import type { Trend } from "@/lib/market/types";
import { marketBreadth, type Breadth } from "@/lib/market/slim-universe";
import type { getCloseSnapshot } from "@/lib/market/tdx-daily.functions";

/** 这一区统一的二级 tab：/flow 下所有子页面共用，增删子页只改这里。 */
/**
 * 资金区的二级 tab。2026-11-12 从 8 个平级 tab 收成 4 个（用户：页面太多，来回都是那几个内容）：
 *
 *   概览    → 四个数字 + 资金汇总 + 分时 + 大盘资金
 *   方向    → 行业与板块（实时行业榜 / 月度温度计 在页内切）
 *   个股    → 个股资金明细
 *   衍生    → 北向 / 两融 / 期指（页内切）
 *
 * 为什么能收：北向、两融、期指是三份「辅助资金数据」，用户从来不会只来看期指；
 * 行业和板块是同一个问题的两个口径（分钟级实时 vs 月度温度），也不该占两个 tab。
 */
export function FlowSectionTabs() {
  return (
    <SectionTabs
      ariaLabel="资金流向"
      tabs={[
        { to: "/flow/", label: "概览" },
        { to: "/flow/sectors", label: "方向" },
        { to: "/flow/stocks", label: "个股" },
        { to: "/flow/north", label: "衍生" },
      ]}
    />
  );
}

/** 方向页的页内切换：实时行业榜（分钟级）↔ 月度温度计（东财三级行业）。 */
export function FlowDirectionTabs({ live }: { live: boolean }) {
  return (
    <div className="flex items-center gap-1 text-[12px]">
      <a
        href="/flow/sectors?view=live"
        aria-current={live ? "page" : undefined}
        className={
          "rounded px-2 py-1 " +
          (live ? "bg-brand/10 font-medium text-brand-text" : "text-muted hover:text-fg")
        }
      >
        实时行业榜
      </a>
      <a
        href="/flow/sectors"
        aria-current={!live ? "page" : undefined}
        className={
          "rounded px-2 py-1 " +
          (!live ? "bg-brand/10 font-medium text-brand-text" : "text-muted hover:text-fg")
        }
      >
        月度温度计
      </a>
    </div>
  );
}

/** 衍生页的页内切换：北向 / 两融 / 期指。三份都是「辅助资金」，不该各占一个 tab。 */
export function FlowDerivedTabs({ active }: { active: "north" | "margin" | "futures" }) {
  const items = [
    { to: "/flow/north", label: "北向", key: "north" },
    { to: "/flow/margin", label: "两融", key: "margin" },
    { to: "/flow/futures", label: "期指", key: "futures" },
  ] as const;
  return (
    <div className="flex items-center gap-1 text-[12px]">
      {items.map((it) => (
        <a
          key={it.key}
          href={it.to}
          aria-current={active === it.key ? "page" : undefined}
          className={
            "rounded px-2 py-1 " +
            (active === it.key ? "bg-brand/10 font-medium text-brand-text" : "text-muted hover:text-fg")
          }
        >
          {it.label}
        </a>
      ))}
    </div>
  );
}

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * 资金页的区块外壳。和 Panel 同一个版式（1px 边框、圆角 6、标题 14px/500），
 * 只多了一行说明：每块都要交代口径——主力不是机构、北向没有盘中净流入——
 * 说明放在标题正下方比塞在右上角读得顺，所以没直接用 Panel（它的 note 在右侧）。
 */
export function Section({
  id,
  title,
  hint,
  children,
}: {
  /** 保留 id/scroll-mt：组件也被页内锚点（如主控台跳转）之外的场景复用，删掉得不偿失 */
  id?: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * 通用列表。加 renderName 是为了让「个股榜的股票名可点开抽屉、行业名不可点」这件事
 * 由**调用方**决定——组件本身不该知道抽屉的存在。
 * FlowRow.id 已经是 sh600519 这种带前缀的格式（实测腾讯资金榜原样返回），所以直接传给
 * StockName 就行，不用反查。
 */
export function List({
  title,
  rows,
  hint,
  renderName,
}: {
  title: string;
  rows: FlowRow[];
  hint?: string;
  renderName?: (row: FlowRow) => ReactNode;
}) {
  return (
    <Section title={title} hint={hint}>
      {rows.length === 0 ? (
        // 不说「暂无数据」——那是零信息量的。说清为什么空、什么时候会有。
        <p className="px-3.5 py-6 text-sm text-muted">这一块源头没给数据，刷新页面会再拉一次。</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 border-t border-line px-3.5 py-2 first:border-t-0">
              <div className="min-w-0">
                <div className="truncate font-medium">{renderName ? renderName(row) : row.name}</div>
                <div className="mt-0.5 text-xs text-muted">
                  <span className={toneClass(row.chg)}>{signedPct(row.chg)}</span>
                  {row.leader ? ` · 领涨 ${row.leader}` : null}
                </div>
              </div>
              <div className={toneClass(row.inflow) + " shrink-0 text-right font-medium tabular-nums"}>{fmtWan(row.inflow)}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function North({ legs }: { legs: NorthLeg[] }) {
  const total = legs.reduce((sum, leg) => sum + leg.amount, 0);
  return (
    <Section
      title="北向"
      hint="沪股通和深股通的盘中净流入不再公布，收盘后也没有净买入。这里只有最近一个已公布交易日的成交额。"
    >
      {legs.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">北向成交额暂时拉不下来。</p>
      ) : (
        <ul className="px-3.5 py-2">
          {legs.map((leg) => (
            <li key={leg.name} className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
              <div>
                <div className="font-medium">{leg.name}</div>
                <div className="text-xs text-muted">
                  {leg.date}
                  {leg.leader ? ` · 成交居前 ${leg.leader}` : ""}
                </div>
              </div>
              <div className="shrink-0 font-medium tabular-nums">{fmtWan(leg.amount)}</div>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 border-t border-line py-2">
            <div className="font-medium">合计成交额</div>
            <div className="font-medium tabular-nums">{fmtWan(total)}</div>
          </li>
        </ul>
      )}
    </Section>
  );
}

/** 概览统计排，学财联社盯盘那排数字：涨跌家数、两市成交额、主力、北向。 */
export function Overview({ tape, parts, north, breadth, hasBreadth, northDegraded }: { tape: { name: string; amount: number; prevAmount?: number | null }[]; parts: MarketPart[]; north: NorthLeg[]; breadth: Breadth; hasBreadth: boolean; northDegraded?: boolean }) {
  const amount = tape.reduce((total, row) => total + row.amount, 0);
  const prevAmount = tape.every((row) => row.prevAmount != null) ? tape.reduce((total, row) => total + (row.prevAmount ?? 0), 0) : null;
  const delta = prevAmount == null ? null : amount - prevAmount;
  const main = parts.length > 0 ? parts.reduce((total, part) => total + part.main, 0) : null;
  const share = amount > 0 && main != null ? (main / amount) * 100 : null;
  const { up, down, limitUp, limitDown } = breadth;
  const northTotal = north.reduce((sum, leg) => sum + leg.amount, 0);
  const tile = "bg-surface px-4 py-3.5";
  const label = "text-xs text-muted";
  const value = "mt-1.5 text-xl font-medium tabular-nums leading-none whitespace-nowrap";
  const foot = "mt-1.5 text-xs text-muted";
  return (
    <section className="overflow-hidden rounded border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">概览</h2>
        <p className="text-xs text-muted">红是净流入，绿是净流出</p>
      </header>
      <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
        <div className={tile}>
          <div className={label}>涨跌家数</div>
          <div className={value}>
            {hasBreadth ? (
              <>
                <span className="text-up tabular-nums">{up}</span>
                <span className="mx-1 text-base text-muted">:</span>
                <span className="text-down tabular-nums">{down}</span>
              </>
            ) : (
              "—"
            )}
          </div>
          <div className={foot}>{hasBreadth ? `涨停 ${limitUp} · 跌停 ${limitDown}` : "全市场行情没拉下来"}</div>
        </div>
        <div className={tile}>
          <div className={label}>两市成交额</div>
          <div className={value}>{amount > 0 ? fmtWan(amount) : "—"}</div>
          <div className={foot}>
            {delta == null ? "较上日 —" : (
              <span className={delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-muted"}>
                较上日 {delta > 0 ? "+" : ""}
                {fmtWan(delta)}（{delta > 0 ? "放量" : delta < 0 ? "缩量" : "持平"}）
              </span>
            )}
          </div>
        </div>
        <div className={tile}>
          <div className={label}>{main == null ? "主力" : main > 0 ? "主力净流入" : main < 0 ? "主力净流出" : "主力持平"}</div>
          <div className={value + " " + toneClass(main)}>{main == null ? "—" : fmtWan(main)}</div>
          <div className={foot}>{share == null ? "占成交额 —" : `占成交额 ${Math.abs(share).toFixed(2)}%`}</div>
        </div>
        <div className={tile}>
          <div className={label}>北向成交额</div>
          <div className={value}>{northTotal > 0 ? fmtWan(northTotal) : "—"}</div>
          <div className={foot + " truncate"}>
            {north.length > 0 ? north.map((leg) => `${leg.name} ${fmtWan(leg.amount)}`).join(" · ") : northDegraded ? "北向成交额暂时拉不到（东财单源降级，重试过）" : "盘中净流入不再公布"}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 万元 → 「+12.9 亿」/「-876 万」。
 *
 * **净流出必须带负号**：装饰件上「-876 万」写成「876 万」会被读成流入——
 * 2026-10-23 在海报层（studio）踩过同款坑，那次是绿字无负号。
 */
export function flowAmount(wan: number): string {
  const abs = Math.abs(wan);
  const sign = wan < 0 ? "-" : "+";
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)} 亿`;
  return `${sign}${Math.round(abs)} 万`;
}

export function flowWord(value: number): string {
  if (value > 0) return "净流入";
  if (value < 0) return "净流出";
  return "持平";
}

function trendDayLabel(date: string): string {
  const match = date.match(/^\d{4}(\d{2})(\d{2})$/);
  if (!match) return date;
  return `${Number(match[1])}月${Number(match[2])}日`;
}

/** 大盘分时走势图：分时线（recharts）/ 5 分钟蜡烛（ECharts）双模式，默认分时。
 *  蜡烛是从逐分钟快照价聚合的派生 OHLC（窗口首/末/极值），口径在脚注照实说。
 *  灰虚线是昨收，板块标签是当前净流入靠前的行业快照。 */
export function TrendChart({ trend, sectors }: { trend: Trend; sectors: FlowRow[] }) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<"line" | "candle">("line");
  useEffect(() => setMounted(true), []);
  const last = trend.points[trend.points.length - 1]?.price ?? null;
  const up = trend.prevClose != null && last != null && last >= trend.prevClose;
  const chg = trend.prevClose != null && last != null && trend.prevClose > 0 ? (last / trend.prevClose - 1) * 100 : null;
  const tickInterval = Math.max(1, Math.floor(trend.points.length / 6));
  const tags = sectors.slice(0, 8);
  // 蜡烛：5 分钟聚合；数据不足一窗时按钮禁用（不画残蜡烛）
  const candles = minuteCandles(trend.points, 5);
  const candleReady = candles.length >= 2;
  const candleYRange = candleReady
    ? (() => {
        const lo = Math.min(...candles.map((c) => c.l), trend.prevClose ?? Infinity);
        const hi = Math.max(...candles.map((c) => c.h), trend.prevClose ?? -Infinity);
        const pad = (hi - lo) * 0.08 || 1;
        return [lo - pad, hi + pad] as [number, number];
      })()
    : undefined;
  return (
    <section className="overflow-hidden rounded border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-3.5 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">大盘走势</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            上证指数，{trendDayLabel(trend.date)}。{mode === "line" ? "分时线，灰虚线是昨收。" : "5 分钟蜡烛（由逐分钟快照价聚合：首=开、末=收、极值=高/低），灰虚线是昨收。"}板块标签是当前主力净流入靠前的行业（快照，不是历史回放）。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {chg != null ? <span className={toneClass(chg) + " text-sm font-medium tabular-nums"}>{signedPct(chg)}</span> : null}
          <div className="flex overflow-hidden rounded border border-line" role="group" aria-label="走势图模式">
            <button
              type="button"
              onClick={() => setMode("line")}
              aria-pressed={mode === "line"}
              className={"px-2 py-0.5 text-[12px] transition " + (mode === "line" ? "bg-brand-soft text-brand-text" : "text-muted hover:text-fg")}
            >
              分时
            </button>
            <button
              type="button"
              onClick={() => candleReady && setMode("candle")}
              aria-pressed={mode === "candle"}
              disabled={!candleReady}
              title={candleReady ? "5 分钟蜡烛" : "分钟数据不足，画不出蜡烛"}
              className={"px-2 py-0.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40 " + (mode === "candle" ? "bg-brand-soft text-brand-text" : "text-muted hover:text-fg")}
            >
              蜡烛
            </button>
          </div>
        </div>
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-2">
          {tags.map((row) => (
            <span key={row.id} className={"rounded-sm px-2 py-0.5 text-xs " + (row.inflow >= 0 ? "bg-up-soft text-up" : "bg-down-soft text-down")}>
              {row.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="h-52">
        {mode === "line" ? (
          mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend.points} margin={{ top: 8, right: 10, left: 10, bottom: 0 }}>
                {trend.prevClose != null ? <ReferenceLine y={trend.prevClose} stroke="var(--color-muted)" strokeDasharray="4 4" /> : null}
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                  tickFormatter={(value: string) => `${value.slice(0, 2)}:${value.slice(2)}`}
                  interval={tickInterval}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide domain={["auto", "auto"]} />
                <Line type="monotone" dataKey="price" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">正在画分时</div>
          )
        ) : (
          <MinuteCandleEChart candles={candles} prevClose={trend.prevClose} yRange={candleYRange} />
        )}
      </div>
    </section>
  );
}

/** 5 分钟蜡烛渲染（ECharts）。颜色读 CSS 变量与全站 token 同源（同 kline-chart 的做法）。 */
function MinuteCandleEChart({ candles, prevClose, yRange }: { candles: ReturnType<typeof minuteCandles>; prevClose: number | null; yRange?: [number, number] | undefined }) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || candles.length < 2) return;
    const upColor = getComputedStyle(document.documentElement).getPropertyValue("--color-up").trim() || "#f2495c";
    const downColor = getComputedStyle(document.documentElement).getPropertyValue("--color-down").trim() || "#0bb97b";
    const line = getComputedStyle(document.documentElement).getPropertyValue("--color-line").trim() || "#242f45";
    const muted = getComputedStyle(document.documentElement).getPropertyValue("--color-muted").trim() || "#8b95a6";
    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      grid: { left: 8, right: 10, top: 12, bottom: 20 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        valueFormatter: (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "—"),
      },
      xAxis: {
        type: "category",
        data: candles.map((c) => hhmm(c.time)),
        axisLine: { lineStyle: { color: line } },
        axisLabel: { color: muted, fontSize: 10 },
        axisTick: { show: false },
      },
      yAxis: {
        scale: true,
        min: yRange?.[0],
        max: yRange?.[1],
        axisLabel: { color: muted, fontSize: 10, formatter: (v: number) => v.toFixed(0) },
        splitLine: { lineStyle: { color: line, opacity: 0.4 } },
      },
      series: [
        ...(prevClose != null
          ? [{
              type: "line" as const,
              data: candles.map(() => prevClose),
              symbol: "none" as const,
              lineStyle: { color: muted, type: "dashed" as const, width: 1 },
              silent: true,
              tooltip: { show: false },
            }]
          : []),
        {
          type: "candlestick",
          data: candles.map((c) => [c.o, c.c, c.l, c.h]),
          itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
        },
      ],
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [candles, prevClose, yRange]);
  if (candles.length < 2) return <div className="flex h-full items-center justify-center text-sm text-muted">分钟数据不足，画不出蜡烛</div>;
  return <div ref={host} className="h-full w-full" />;
}

export function Market({ parts }: { parts: MarketPart[] }) {
  const sum = (key: keyof Omit<MarketPart, "name">) => parts.reduce((total, part) => total + part[key], 0);
  const rows: { name: string; key: keyof Omit<MarketPart, "name"> }[] = [
    { name: "主力", key: "main" },
    { name: "超大单", key: "super" },
    { name: "大单", key: "big" },
    { name: "中单", key: "mid" },
    { name: "小单", key: "small" },
    { name: "散户", key: "retail" },
  ];
  return (
    <Section
      title="大盘资金"
      hint="主力净流入大约一分钟更新。红是净流入，绿是净流出。"
    >
      {parts.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">大盘资金暂时拉不下来。</p>
      ) : (
        <Table
          className="data-table"
          caption={`大盘资金流向：${rows.length} 类资金在 ${parts.length} 个板块的净流入`}
        >
          <thead>
            <tr>
              <th className={thClass("text-left")}>成分</th>
              <th className={thClass()}>合计净流入</th>
              {parts.map((part) => (
                <th key={part.name} className={thClass()}>
                  {part.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className={
                  "border-t border-line first:border-t-0 " +
                  (row.key === "main" || row.key === "retail" ? "font-medium" : "text-muted")
                }
              >
                <td className={tdClass("text-left")}>{row.name}</td>
                <td data-l="合计" className={tdClass(toneClass(sum(row.key)))}>
                  {flowWord(sum(row.key))} {fmtWan(sum(row.key))}
                </td>
                {parts.map((part) => (
                  <td key={part.name} data-l={part.name} className={tdClass(toneClass(part[row.key]))}>
                    {flowWord(part[row.key])} {fmtWan(part[row.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {parts.length > 0 ? (
        <ul className="border-t border-line px-3.5 py-2 text-sm text-muted">
          {readMarket(parts).map((line) => (
            <li key={line} className="py-1 text-pretty">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-line px-3.5 py-2">
        <h3 className="text-sm font-medium">另外三类</h3>
        <ul className="mt-2 text-sm">
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>机构</span>
            <span className="text-right text-muted">没有全市场席位净额。主力不是机构。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>外资</span>
            <span className="text-right text-muted">北向净买入不公布，北向子页只有成交额。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>国家队</span>
            <span className="text-right text-muted">汇金、证金没有盘中净流入。</span>
          </li>
        </ul>
      </div>
    </Section>
  );
}

/** 两融（D3）快照的 loader 形状（getMargin 的返回）。rows 有全市场四千多只，页面只取头部。 */
export type MarginPayload = {
  date: string;
  rows: MarginRow[];
  missing: number;
  fetchedAt: string | null;
  why: string | null;
} | null;

/** 两融（D3）：全市场杠杆总账 + 融资余额头部个股 + 缺口显式。数据来自 fetch-margin.ts 落盘快照。 */
export function Margin({ data }: { data: MarginPayload }) {
  if (!data || data.rows.length === 0) {
    return (
      <Section title="两融" hint="杠杆资金的总账和个股明细。T+1 发布，收盘后跑抓取脚本更新。">
        <p className="px-3.5 py-6 text-sm text-muted">{data?.why ?? "两融快照暂时没有。"}</p>
      </Section>
    );
  }
  const totalRzye = data.rows.reduce((s, r) => s + r.rzye, 0) / 1e8;
  const totalRzjme = data.rows.reduce((s, r) => s + r.rzjme, 0) / 1e8;
  const top = data.rows.slice(0, 10);
  return (
    <Section
      title="两融"
      hint={`杠杆资金总账（${data.date}，东财，T+1 发布）。融资余额是全市场杠杆的总水位；占比高 = 这只票筹码杠杆重，跌起来去杠杆会放大。`}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-3.5 py-2 text-sm">
        <span>
          融资余额 <b className="font-medium tabular-nums">{totalRzye.toFixed(0)}</b> 亿
        </span>
        <span className={toneClass(totalRzjme)}>
          当日融资净买 <b className="font-medium tabular-nums">{totalRzjme > 0 ? "+" : ""}{totalRzjme.toFixed(1)}</b> 亿
        </span>
      </div>
      <ul className="px-3.5 py-2">
        {top.map((row) => (
          <li key={row.id} className="flex items-baseline justify-between gap-2 border-t border-line py-1.5 text-sm first:border-t-0">
            <span className="min-w-0 truncate">{row.name}</span>
            <span className="shrink-0 tabular-nums text-muted">
              融资 {(row.rzye / 1e8).toFixed(1)} 亿 · 占比 {row.ratio == null ? "—" : `${row.ratio.toFixed(1)}%`}
              {row.rzjme !== 0 ? (
                <span className={toneClass(row.rzjme / 1e8)}> · 净买 {(row.rzjme / 1e8).toFixed(2)} 亿</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="px-3.5 pb-3">
        <p className="text-[12px] text-muted">
          取于 {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}（本机时区）· 来源：东财
          datacenter 两融明细，原名原样 · 快照 data/risk/margin-latest.json
        </p>
        <GapList items={data.missing > 0 ? [`源数据坏行 ${data.missing} 条（解析不过，已跳过）`] : []} />
      </div>
    </Section>
  );
}

function lotsText(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}万手`;
  return `${Math.round(abs)}手`;
}

export function Futures({ book }: { book: FutBook | null }) {
  return (
    <Section
      title="股指期货"
      hint={
        "中金所前 20 名会员的多单和空单。公布的是代客，不是单独的机构账户。" +
        (book?.date ? ` ${book.date}` : "")
      }
    >
      {!book || book.rows.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">股指期货持仓暂时没有。</p>
      ) : (
        <Table
          className="data-table"
          caption={`股指期货前 20 名会员持仓，共 ${book.rows.length} 个合约`}
        >
          <thead>
            <tr>
              <th className={thClass("text-left")}>合约</th>
              <th className={thClass()}>多单</th>
              <th className={thClass()}>空单</th>
              <th className={thClass()}>净持仓</th>
            </tr>
          </thead>
          <tbody>
            {book.rows.map((row) => {
              const net = row.longLots - row.shortLots;
              return (
                <tr key={row.contract} className="border-t border-line first:border-t-0">
                  <td className={tdClass("text-left")}>
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted">{row.contract}</div>
                  </td>
                  <td data-l="多单" className={tdClass("text-up")}>
                    {lotsText(row.longLots)}
                  </td>
                  <td data-l="空单" className={tdClass("text-down")}>
                    {lotsText(row.shortLots)}
                  </td>
                  <td data-l="净持仓" className={tdClass(toneClass(net))}>
                    {net > 0 ? "净多" : net < 0 ? "净空" : "持平"} {lotsText(net)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

/**
 * 收盘快照（通达信盘后包）。
 *
 * **这一块和页面其他数字不是一回事**，三条差别写在 hint 里：
 * 1. 别处是**腾讯盘中快照**，每分钟变；这一块是**收盘后的定盘数据**
 * 2. 涨跌幅由盘后包自己的**昨收**算，不借任何快照源
 * 3. **它含北交所**——腾讯和新浪都把 bj 挡掉了，其他页面拿不到这一块
 *
 * 数据截至哪天不一定是今天：盘后包要收盘后数小时才发布，而且它是**增量**
 * （每天要跑一次 `python3 scripts/fetch-tdx-package.py`），中间可能缺好几天。
 */
export function CloseSnapshotPanel({ close }: { close: Awaited<ReturnType<typeof getCloseSnapshot>> | null }) {
  if (!close?.snapshot) {
    return (
      <Section
        title="收盘快照"
        hint={close?.why ?? "还没抓过盘后包。跑一次 python3 scripts/fetch-tdx-package.py（收盘后数小时才有当天的包）"}
      >
        <p className="px-3.5 py-6 text-sm text-muted">
          这一块要通达信盘后包。它是<strong>收盘后的定盘数据</strong>，也是资金流向区唯一含
          <strong>北交所</strong>的数字——腾讯和新浪都不给北交所。
        </p>
      </Section>
    );
  }
  const s = close.snapshot;
  const fmtAmount = (v: number): string =>
    v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : `${(v / 1e4).toFixed(0)} 万`;
  return (
    <Section
      title="收盘快照（通达信盘后包）"
      hint={`数据截至 ${s.date} · ${s.totalCount} 只全市场，其中北交所 ${s.bjCount} 只（别处拿不到）。涨跌幅由盘后包自己的昨收算，不借盘中快照。`}
    >
      <table className="w-full">
        <caption className="sr-only">收盘成交额前 {s.top.length} 名：代码、名称、板块、收盘价、涨跌幅、成交额</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className={thClass("text-left")}>名称</th>
            <th className={thClass("text-left")}>板块</th>
            <th className={thClass()}>收盘</th>
            <th className={thClass()}>涨跌幅</th>
            <th className={thClass()}>成交额</th>
          </tr>
        </thead>
        <tbody>
          {s.top.map((row) => (
            <tr key={row.id} className="border-t border-line/60">
              <td className={tdClass("text-left")}>
                <StockName id={row.id} name={row.name} source="flow" />
              </td>
              <td className={tdClass("text-left text-muted")}>{row.board}</td>
              <td className={tdClass("text-right tabular-nums text-muted")}>{row.price}</td>
              <td className={tdClass("text-right tabular-nums " + toneClass(row.chg))}>{signedPct(row.chg)}</td>
              <td className={tdClass("text-right tabular-nums text-muted")}>{fmtAmount(row.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.bjTop.length > 0 ? (
        <div className="border-t border-line px-3.5 py-2">
          <p className="pb-1 text-xs text-muted">
            <strong className="text-fg">北交所成交额前 {s.bjTop.length}</strong>
            <span className="ml-1">全市场 TOP{s.top.length} 里一只北交所都没有——流动性差两个数量级，所以单列。这一块是资金流向区别处拿不到的（腾讯和新浪都挡掉 bj）。</span>
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {s.bjTop.map((row) => (
              <li key={row.id} className="text-xs">
                <StockName id={row.id} name={row.name} source="flow" />
                <span className={"ml-1 tabular-nums " + toneClass(row.chg)}>{signedPct(row.chg)}</span>
                <span className="ml-1 tabular-nums text-muted">{fmtAmount(row.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
