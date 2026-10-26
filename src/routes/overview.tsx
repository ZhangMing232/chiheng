/**
 * 这个文件是干什么的：
 * 「股市总览」页 —— 一屏看全市场：指数、涨跌分布、资金、快讯。
 *
 * 你需要知道的：
 * - 数据全是现成的：getIndices（指数）、getBreadth（涨跌分布计数，服务端算好）、
 *   getFlow（资金）、getNews（快讯）。
 * - 涨跌分布是服务端算好的计数，不把全市场几千只票塞给客户端（SSR HTML 不膨胀）。
 * - 这一页只做「看」，不接策略、不接买卖（和 /overseas 同一条纪律）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getBreadth, getFlow, getIndices, getNews } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";
import type { IndexQuote } from "@/lib/market/types";
import type { FlowBook } from "@/lib/market/flow";
import type { NewsItem } from "@/lib/market/news";

/** 万元 → 亿/万，带符号（净流出是负的）。装饰件只显示真实的数。 */
function fmtYi(wan: number): string {
  const abs = Math.abs(wan);
  const sign = wan < 0 ? "-" : "+";
  return abs >= 1e4 ? `${sign}${(abs / 1e4).toFixed(1)} 亿` : `${sign}${Math.round(abs)} 万`;
}

export const Route = createFileRoute("/overview")({
  loader: async () => {
    const [indices, breadth, flow, news] = await Promise.all([
      getIndices().catch(() => null),
      getBreadth().catch(() => null),
      getFlow().catch(() => null),
      getNews().catch(() => null),
    ]);
    return { indices, breadth, flow, news };
  },
  component: OverviewPage,
});

function OverviewPage() {
  const { indices, breadth, flow, news } = Route.useLoaderData();

  return (
    <Frame
      aside="股市总览"
      status={{
        label: "上涨",
        // **真实数据**：getBreadth 服务端算好的计数。没有快照就是 null，
        // 页头就少这个药丸——不能拿 0 顶替「不知道」。
        value: breadth ? `${breadth.up} / ${breadth.down}` : null,
        tone: breadth ? (breadth.up > breadth.down ? "ok" : "warn") : "neutral",
      }}
      ornamentContent={
        flow && flow.stocksIn.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            第一名 {flow.stocksIn[0]!.name} {fmtYi(flow.stocksIn[0]!.inflow)}
          </span>
        ) : (
          <span className="text-[11px]">资金榜暂不可用</span>
        )
      }
    >
      <h1 className="font-display text-xl font-medium tracking-wide">涨跌分布</h1>
      {/* 指数 */}
      <Panel title="指数" note={indices?.[0]?.time ? `行情时间 ${indices[0].time}` : undefined}>
        {!indices || indices.length === 0 ? (
          <StateBlock kind="empty" title="没拉到指数" hint="稍后再试，或看「港美行情」页。" />
        ) : (
          <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-3 lg:grid-cols-4">
            {indices.map((q: IndexQuote) => (
              <Stat
                key={q.id}
                label={q.name}
                value={q.price.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                tone={toneClass(q.pct)}
                hint={`${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}% · ${q.chg >= 0 ? "+" : ""}${q.chg.toFixed(2)}`}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* 涨跌分布 */}
      <Panel title="市场广度" note={breadth ? `${breadth.total} 只（全市场快照现算）` : undefined}>
        {!breadth ? (
          <StateBlock kind="empty" title="没拉到全市场快照" hint="行情源没返回。稍后再试。" />
        ) : (
          <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-5">
            <Stat label="上涨" value={String(breadth.up)} tone="text-up" hint={`${breadth.total > 0 ? ((breadth.up / breadth.total) * 100).toFixed(1) : "0"}%`} />
            <Stat label="下跌" value={String(breadth.down)} tone="text-down" hint={`${breadth.total > 0 ? ((breadth.down / breadth.total) * 100).toFixed(1) : "0"}%`} />
            <Stat label="平盘" value={String(breadth.flat)} />
            <Stat label="涨停" value={String(breadth.limitUp)} tone="text-up" />
            <Stat label="跌停" value={String(breadth.limitDown)} tone="text-down" />
          </div>
        )}
      </Panel>

      {/* 资金 */}
      <Panel title="资金" note={flow ? "主力净流入前 5 · 单位亿元" : undefined}>
        {!flow ? (
          <StateBlock kind="empty" title="没拉到资金" hint="稍后再试。" />
        ) : (
          <div className="grid gap-3 px-3.5 py-3 lg:grid-cols-2">
            <FlowList title="板块主力净流入前 5" rows={flow.sectorsIn.slice(0, 5)} />
            <FlowList title="板块主力净流出前 5" rows={flow.sectorsOut.slice(0, 5)} />
          </div>
        )}
      </Panel>

      {/* 快讯 */}
      <Panel title="快讯" note={news ? `最近 ${Math.min(news.length, 10)} 条 · 约每分钟更新` : undefined}>
        {!news || news.length === 0 ? (
          <StateBlock kind="empty" title="没拉到快讯" hint="稍后再试，或看「快讯」页。" />
        ) : (
          <ul className="divide-y divide-line/60 px-1">
            {news.slice(0, 10).map((n: NewsItem) => (
              <li key={n.id} className="flex items-start gap-2 px-2.5 py-2">
                <span className="shrink-0 text-[11px] tabular-nums text-muted">{n.time.slice(11, 16)}</span>
                <span className={"shrink-0 text-[11px] " + (n.tone === "good" ? "text-up" : n.tone === "bad" ? "text-down" : "text-muted")}>
                  {n.tone === "good" ? "利好" : n.tone === "bad" ? "利空" : "中性"}
                </span>
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg">{n.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Frame>
  );
}

function FlowList({ title, rows }: { title: string; rows: FlowBook["sectorsIn"] }) {
  return (
    <div>
      <h3 className="px-3.5 pb-1 pt-2 text-xs font-medium text-muted">{title}</h3>
      <table className="data-table w-full">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="border-b border-line">
            <th className={tdClass("text-left")}>板块</th>
            <th className={tdClass()}>涨跌幅</th>
            <th className={tdClass()}>主力净流入</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className={tdClass("text-left text-muted")}>
                暂无数据
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="border-b border-line/60">
                <td className={tdClass("text-left text-fg")}>{r.name}</td>
                <td className={tdClass("text-right " + toneClass(r.chg))}>{r.chg == null ? "—" : `${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}%`}</td>
                <td className={tdClass("text-right text-muted")}>{(r.inflow / 1e4).toFixed(1)} 亿</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
