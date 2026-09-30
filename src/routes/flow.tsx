/**
 * 这个文件是干什么的：
 * 「资金」页，版面参考财联社盯盘。顶部是指数条和深色子页签，概览一排四个数字
 * （涨跌家数、两市成交额、主力、北向），再往下是大盘资金明细、北向、行业、
 * 个股、游资席位和股指期货。每一块都能单独生成汇总图。
 *
 * 你需要知道的：
 * 这里只展示。北向没有盘中净流入。生成图片不会改变买入价。
 */

import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { INDEX_LABEL } from "@/components/screener/screener";
import { fmtPrice, fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { limitTag } from "@/lib/market/model";
import { drawFlowPoster } from "@/lib/market/flow-poster";
import { getFlow, getHotMoney, getIndexFutures, getIndices, getTrend, getUniverse } from "@/lib/market/quotes.functions";
import { drawFuturesPoster, drawHotPoster } from "@/lib/market/extra-posters";
import { readMarket, type FlowRow, type MarketPart, type NorthLeg } from "@/lib/market/flow";
import type { HotBook } from "@/lib/market/hotmoney";
import type { FutBook } from "@/lib/market/index-futures";
import type { IndexQuote, Quote, Trend } from "@/lib/market/types";

/** 资金页路由。进来时同时去拉资金流向、指数、分时、全市场涨跌、游资和股指期货，某一块失败就那一块空着。 */
export const Route = createFileRoute("/flow")({
  loader: async () => {
    const [book, hot, futures, indices, universe, trend] = await Promise.all([
      getFlow().catch((error: unknown) => ({ error })),
      getHotMoney().catch(() => null),
      getIndexFutures().catch(() => null),
      getIndices().catch(() => [] as IndexQuote[]),
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getTrend({ data: { id: "sh000001" } }).catch(() => null),
    ]);
    const quotes = universe?.quotes ?? [];
    if (book && typeof book === "object" && "error" in book) {
      return {
        book: null,
        hot: null as HotBook | null,
        futures: null as FutBook | null,
        indices,
        quotes,
        trend,
        error: book.error instanceof Error ? book.error.message : "资金流向暂时拉不下来",
      };
    }
    return { book, hot, futures, indices, quotes, trend, error: null as string | null };
  },
  component: FlowPage,
});

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** 财联社式章节标题：红色竖条 + 衬线大字。 */
function SectionTitle({ children }: { children: string }) {
  return <h2 className="border-l-2 border-brand pl-2 font-serif text-lg font-semibold">{children}</h2>;
}

const TABS = [
  { id: "flow-overview", label: "概览" },
  { id: "flow-trend", label: "走势" },
  { id: "flow-market", label: "大盘资金" },
  { id: "flow-north", label: "北向" },
  { id: "flow-sectors", label: "行业" },
  { id: "flow-stocks", label: "个股" },
  { id: "flow-hot", label: "游资" },
  { id: "flow-futures", label: "期指" },
] as const;

/** 深色子页签条，学财联社盯盘的「看盘 / 行情 / 自选」。点一下平滑滚到那一块，滚动时高亮当前块。 */
function FlowTabs() {
  const [active, setActive] = useState<string>(TABS[0].id);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-10% 0px -75% 0px" },
    );
    for (const tab of TABS) {
      const el = document.getElementById(tab.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <div className="-mx-4 bg-navy px-4 md:-mx-6 md:px-6">
      <div className="flex gap-5 overflow-x-auto scroll-slim">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActive(tab.id);
              document.getElementById(tab.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={"shrink-0 border-b-2 py-2 text-sm " + (active === tab.id ? "border-brand font-medium text-white" : "border-transparent text-white/60")}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function List({ title, rows, hint }: { title: string; rows: FlowRow[]; hint?: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="px-4 py-3">
        <SectionTitle>{title}</SectionTitle>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">没有数据。</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 border-t border-line px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{row.name}</div>
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
    </section>
  );
}

function North({ legs }: { legs: NorthLeg[] }) {
  const total = legs.reduce((sum, leg) => sum + leg.amount, 0);
  return (
    <section id="flow-north" className="scroll-mt-24 rounded-lg border border-line bg-surface px-4 py-3">
      <SectionTitle>北向</SectionTitle>
      <p className="mt-1 text-sm text-muted">沪股通和深股通的盘中净流入不再公布，收盘后也没有净买入。这里只有最近一个已公布交易日的成交额。</p>
      {legs.length === 0 ? (
        <p className="mt-3 text-sm text-muted">北向成交额暂时拉不下来。</p>
      ) : (
        <ul className="mt-3">
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
    </section>
  );
}

/** 概览统计排，学财联社盯盘那排数字：涨跌家数、两市成交额、主力、北向。 */
function Overview({ tape, parts, north, quotes }: { tape: { name: string; amount: number; prevAmount?: number | null }[]; parts: MarketPart[]; north: NorthLeg[]; quotes: Quote[] }) {
  const amount = tape.reduce((total, row) => total + row.amount, 0);
  const prevAmount = tape.every((row) => row.prevAmount != null) ? tape.reduce((total, row) => total + (row.prevAmount ?? 0), 0) : null;
  const delta = prevAmount == null ? null : amount - prevAmount;
  const main = parts.length > 0 ? parts.reduce((total, part) => total + part.main, 0) : null;
  const share = amount > 0 && main != null ? (main / amount) * 100 : null;
  const up = quotes.filter((quote) => (quote.chg ?? 0) > 0).length;
  const down = quotes.filter((quote) => (quote.chg ?? 0) < 0).length;
  const limitUp = quotes.filter((quote) => limitTag(quote) === "涨停").length;
  const limitDown = quotes.filter((quote) => limitTag(quote) === "跌停").length;
  const northTotal = north.reduce((sum, leg) => sum + leg.amount, 0);
  const hasBreadth = quotes.length > 0;
  const tile = "bg-surface px-4 py-4";
  const label = "text-xs text-muted";
  const value = "mt-1 text-2xl font-semibold tabular-nums leading-none";
  return (
    <section id="flow-overview" className="scroll-mt-24 overflow-hidden rounded-lg border border-line bg-surface">
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
          <div className="mt-2 text-xs text-muted">{hasBreadth ? `涨停 ${limitUp} · 跌停 ${limitDown}` : "全市场行情没拉下来"}</div>
        </div>
        <div className={tile}>
          <div className={label}>两市成交额</div>
          <div className={value}>{amount > 0 ? fmtWan(amount) : "—"}</div>
          <div className="mt-2 text-xs text-muted">
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
          <div className="mt-2 text-xs text-muted">{share == null ? "占成交额 —" : `占成交额 ${Math.abs(share).toFixed(2)}%`}</div>
        </div>
        <div className={tile}>
          <div className={label}>北向成交额</div>
          <div className={value}>{northTotal > 0 ? fmtWan(northTotal) : "—"}</div>
          <div className="mt-2 truncate text-xs text-muted">{north.length > 0 ? north.map((leg) => `${leg.name} ${fmtWan(leg.amount)}`).join(" · ") : "最近公布日"}</div>
        </div>
      </div>
    </section>
  );
}

function flowWord(value: number): string {
  if (value > 0) return "净流入";
  if (value < 0) return "净流出";
  return "持平";
}

function trendDayLabel(date: string): string {
  const match = date.match(/^\d{4}(\d{2})(\d{2})$/);
  if (!match) return date;
  return `${Number(match[1])}月${Number(match[2])}日`;
}

/** 大盘分时走势图，学财联社盯盘的分时线。灰虚线是昨收，板块标签是当前净流入靠前的行业快照。 */
function TrendChart({ trend, sectors }: { trend: Trend; sectors: FlowRow[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const last = trend.points[trend.points.length - 1]?.price ?? null;
  const up = trend.prevClose != null && last != null && last >= trend.prevClose;
  const chg = trend.prevClose != null && last != null && trend.prevClose > 0 ? (last / trend.prevClose - 1) * 100 : null;
  const tickInterval = Math.max(1, Math.floor(trend.points.length / 6));
  const tags = sectors.slice(0, 8);
  return (
    <section id="flow-trend" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <SectionTitle>大盘走势</SectionTitle>
          <p className="mt-1 text-xs text-muted">上证指数分时，{trendDayLabel(trend.date)}。灰虚线是昨收。板块标签是当前主力净流入靠前的行业（快照，不是历史回放）。</p>
        </div>
        {chg != null ? <span className={toneClass(chg) + " shrink-0 text-sm font-medium tabular-nums"}>{signedPct(chg)}</span> : null}
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2">
          {tags.map((row) => (
            <span key={row.id} className={"rounded-sm px-1.5 py-0.5 text-xs " + (row.inflow >= 0 ? "bg-up-soft text-up" : "bg-down-soft text-down")}>
              {row.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="h-52 border-t border-line">
        {mounted ? (
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
        )}
      </div>
    </section>
  );
}

function Market({ parts }: { parts: MarketPart[] }) {
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
    <section id="flow-market" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="px-4 pt-3">
        <SectionTitle>大盘资金</SectionTitle>
        <p className="mt-1 text-xs text-muted">主力净流入大约一分钟更新。红是净流入，绿是净流出。</p>
      </div>
      {parts.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">大盘资金暂时拉不下来。</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">成分</th>
                <th className="px-4 py-2 text-right font-normal">合计净流入</th>
                {parts.map((part) => (
                  <th key={part.name} className="px-4 py-2 text-right font-normal">
                    {part.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={"border-t border-line " + (row.key === "main" || row.key === "retail" ? "font-medium" : "text-muted")}>
                  <td className="px-4 py-2">{row.name}</td>
                  <td className={toneClass(sum(row.key)) + " px-4 py-2 text-right tabular-nums"}>
                    {flowWord(sum(row.key))} {fmtWan(sum(row.key))}
                  </td>
                  {parts.map((part) => (
                    <td key={part.name} className={toneClass(part[row.key]) + " px-4 py-2 text-right tabular-nums"}>
                      {flowWord(part[row.key])} {fmtWan(part[row.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parts.length > 0 ? (
        <ul className="border-t border-line px-4 py-3 text-sm text-muted">
          {readMarket(parts).map((line) => (
            <li key={line} className="py-1 text-pretty">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-line px-4 py-3">
        <h3 className="text-sm font-semibold">另外三类</h3>
        <ul className="mt-2 text-sm">
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>机构</span>
            <span className="text-right text-muted">没有全市场席位净额。主力不是机构。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>外资</span>
            <span className="text-right text-muted">北向净买入不公布，下面只有成交额。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>国家队</span>
            <span className="text-right text-muted">汇金、证金没有盘中净流入。</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

function Hot({ book }: { book: HotBook | null }) {
  return (
    <section id="flow-hot" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="px-4 py-3">
        <SectionTitle>游资</SectionTitle>
        <p className="mt-1 text-xs text-muted">
          一行一个席位，红是净买，绿是净卖。对得上的才用别名，其余用路名。机构和拉萨放在最后。收盘后才有。
          {book?.date ? ` ${book.date}` : ""}
        </p>
      </div>
      {!book || book.seats.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">游资龙虎榜暂时没有。</p>
      ) : (
        <ul className="border-t border-line">
          {book.seats.map((seat) => (
            <li key={seat.name} className="grid grid-cols-[5.5rem_1fr] gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <div className="font-medium">{seat.name}</div>
              <p className="text-sm leading-6">
                {seat.stocks.map((stock) => (
                  <span key={stock.name} className={toneClass(stock.netWan) + " mr-3 inline-block"}>
                    {stock.name} {stock.netWan > 0 ? "净买" : "净卖"}
                    {fmtWan(Math.abs(stock.netWan))}
                  </span>
                ))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function lotsText(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}万手`;
  return `${Math.round(abs)}手`;
}

function Futures({ book }: { book: FutBook | null }) {
  return (
    <section id="flow-futures" className="scroll-mt-24 rounded-lg border border-line bg-surface">
      <div className="px-4 py-3">
        <SectionTitle>股指期货</SectionTitle>
        <p className="mt-1 text-xs text-muted">中金所前20名会员的多单和空单。公布的是代客，不是单独的机构账户。{book?.date ? ` ${book.date}` : ""}</p>
      </div>
      {!book || book.rows.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">股指期货持仓暂时没有。</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">合约</th>
                <th className="px-3 py-2 text-right font-normal">多单</th>
                <th className="px-3 py-2 text-right font-normal">空单</th>
                <th className="px-4 py-2 text-right font-normal">净持仓</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map((row) => {
                const net = row.longLots - row.shortLots;
                return (
                  <tr key={row.contract} className="border-t border-line">
                    <td className="px-4 py-2">
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted">{row.contract}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-up">{lotsText(row.longLots)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-down">{lotsText(row.shortLots)}</td>
                    <td className={toneClass(net) + " px-4 py-2 text-right tabular-nums"}>
                      {net > 0 ? "净多" : net < 0 ? "净空" : "持平"} {lotsText(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FlowPage() {
  const { book, hot, futures, indices, quotes, trend, error } = Route.useLoaderData();

  return (
    <Frame
      extra={
        indices.length > 0 ? (
          <div className="flex gap-5 overflow-x-auto scroll-slim pb-2">
            {indices.map((item) => (
              <div key={item.id} className="flex shrink-0 items-baseline gap-1.5 text-xs">
                <span className="text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                <span className={cx("tabular-nums", toneClass(item.pct))}>{item.price > 0 ? fmtPrice(item.price) : "—"}</span>
                <span className={cx("font-medium tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
              </div>
            ))}
          </div>
        ) : null
      }
    >
        <p className="text-sm text-muted">红是净流入，绿是净流出。不改变买入价。</p>
        {error ? <p className="text-sm text-up">{error}</p> : null}
        <FlowTabs />
        {book ? (
          <>
            <PosterButton draw={() => drawFlowPoster(book)} />
            <Overview tape={book.tape} parts={book.market} north={book.north} quotes={quotes} />
            {trend ? <TrendChart trend={trend} sectors={book.sectorsIn} /> : null}
            <Market parts={book.market} />
          </>
        ) : null}
        <North legs={book?.north ?? []} />
        {book ? (
          <div id="flow-sectors" className="scroll-mt-24 flex flex-col gap-3">
            <List title="行业净流入" rows={book.sectorsIn} />
            <List title="行业净流出" rows={book.sectorsOut} />
          </div>
        ) : null}
        {book ? (
          <div id="flow-stocks" className="scroll-mt-24 flex flex-col gap-3">
            <List title="个股净流入" rows={book.stocksIn} hint="已去掉新股和 ST。" />
            <List title="个股净流出" rows={book.stocksOut} hint="已去掉新股和 ST。" />
          </div>
        ) : null}
        <PosterButton draw={() => drawHotPoster(hot ?? { date: "", seats: [] })} />
        <Hot book={hot} />
        <PosterButton draw={() => drawFuturesPoster(futures ?? { date: "", rows: [] })} />
        <Futures book={futures} />
      </Frame>
  );
}
