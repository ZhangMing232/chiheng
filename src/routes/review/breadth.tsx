/**
 * 这个文件是干什么的：
 * 「涨跌分布」子页（原 /overview，2026-11-11 并进复盘区）。
 * 一屏看全市场：KPI 头版、涨跌分布直方图、指数、资金、快讯。
 * 2026-11-10 按效果图重构：五张 KPI 卡 + 占比条 + 11 桶直方图 + 页脚。
 * 为什么并进来：它和「每日复盘」都是市场视图，指数/资金/快讯三块完全重复，
 * 只有「11 桶直方图」是独有的。合并后 /review 成为完整的市场分析区。
 * /overview 保留为重定向，书签不断。
 *
 * 你需要知道的：
 * - 数据全是现成的：getIndices（指数）、getBreadth（涨跌计数 + 分桶，服务端一次
 *   扫描算好）、getFlow（资金）、getNews（快讯）。全市场几千只票不进客户端。
 * - 直方图口径钉在 slim-universe.test.ts：涨跌停按板单列，中间九档按涨跌幅。
 * - 这一页只做「看」，不接策略、不接买卖（和 /overseas 同一条纪律）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { SectionTabs, REVIEW_TABS } from "@/components/section-tabs";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { HeroStat } from "@/components/hero-stat";
import { getBreadth, getFlow, getIndices, getNews } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";
import type { IndexQuote } from "@/lib/market/types";
import type { FlowBook } from "@/lib/market/flow";
import type { NewsItem } from "@/lib/market/news";
import { BarChart3, Coins, Flame, LineChart, TrendingUp } from "lucide-react";
import { PixelHeader } from "@/components/pixel-header";

/** 万元 → 亿/万，带符号（净流出是负的）。装饰件只显示真实的数。 */
function fmtYi(wan: number): string {
  const abs = Math.abs(wan);
  const sign = wan < 0 ? "-" : "+";
  return abs >= 1e4 ? `${sign}${(abs / 1e4).toFixed(1)} 亿` : `${sign}${Math.round(abs)} 万`;
}

export const Route = createFileRoute("/review/breadth")({
  loader: async () => {
    const [indices, breadth, flow, news] = await Promise.all([
      getIndices().catch(() => null),
      getBreadth().catch(() => null),
      getFlow().catch(() => null),
      getNews().catch(() => null),
    ]);
    // 新鲜度条的「延迟/是否过期」依赖当前时刻：放进 loader 算一次、随 loader 数据序列化，
    // SSR 与客户端 hydration 拿到同一个值，不会因时刻差触发 #418。
    return { indices, breadth, flow, news, serverNow: Date.now() };
  },
  component: OverviewPage,
});

function OverviewPage() {
  const { indices, breadth, flow, news, serverNow } = Route.useLoaderData();

  const tapeAmount = flow && flow.tape.length > 0 ? flow.tape.reduce((t, r) => t + r.amount, 0) : null;
  const prevTape = flow && flow.tape.length > 0 ? flow.tape.reduce((t, r) => t + (r.prevAmount ?? 0), 0) : null;
  const tapeChg = tapeAmount != null && prevTape ? (tapeAmount / prevTape - 1) * 100 : null;
  const hs300 = indices?.find((i) => i.id === "sh000300");
  const shIdx = indices?.find((i) => i.id === "sh000001");
  const pctWord = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

  // 结论句：只报事实（红线下不写操作建议）
  const marketLine = [
    breadth
      ? `上涨 ${breadth.up} 家（${breadth.total > 0 ? ((breadth.up / breadth.total) * 100).toFixed(1) : "0"}%）vs 下跌 ${breadth.down} 家，${breadth.up >= breadth.down ? "涨多跌少" : "跌多涨少"}`
      : "全市场快照还没拉到",
    tapeAmount != null ? `两市成交 ${fmtYi(tapeAmount).replace("+", "")}${tapeChg != null ? `，较昨日 ${pctWord(tapeChg)}` : ""}` : null,
    hs300 ? `沪深300 ${pctWord(hs300.pct)}` : null,
  ]
    .filter((s): s is string => s != null)
    .join("；") + "。";

  const buckets = breadth?.buckets;
  const bucketRows = buckets
    ? ([
        { k: "涨停", v: buckets.upLimit, cls: "bg-up" },
        { k: ">+7%", v: buckets.gt7, cls: "bg-up/80" },
        { k: "+5~7%", v: buckets.p5_7, cls: "bg-up/60" },
        { k: "+3~5%", v: buckets.p3_5, cls: "bg-up/45" },
        { k: "0~+3%", v: buckets.p0_3, cls: "bg-up/30" },
        { k: "平盘", v: buckets.flat, cls: "bg-muted/40" },
        { k: "0~-3%", v: buckets.n0_3, cls: "bg-down/30" },
        { k: "-3~-5%", v: buckets.n3_5, cls: "bg-down/45" },
        { k: "-5~-7%", v: buckets.n5_7, cls: "bg-down/60" },
        { k: "<-7%", v: buckets.lt7, cls: "bg-down/80" },
        { k: "跌停", v: buckets.downLimit, cls: "bg-down" },
      ] as const)
    : [];
  const bucketMax = Math.max(...bucketRows.map((r) => r.v), 1);
  const upPct = breadth && breadth.total > 0 ? (breadth.up / breadth.total) * 100 : 0;
  const downPct = breadth && breadth.total > 0 ? (breadth.down / breadth.total) * 100 : 0;
  const flatPct = Math.max(0, 100 - upPct - downPct);

  return (
    <Frame wide
      aside="涨跌分布"
      freshness={
        flow
          ? {
              state: flow.asOf && serverNow - flow.asOf > 120_000 ? "delayed" : "healthy",
              label: flow.asOf && serverNow - flow.asOf > 120_000 ? "涨跌数据延迟" : "涨跌数据正常",
              source: "腾讯全市场快照",
              updatedAt: flow.asOf ? new Date(flow.asOf).toTimeString().slice(0, 8) : undefined,
              latencySeconds: flow.asOf ? Math.round((serverNow - flow.asOf) / 1000) : undefined,
              canRetry: true,
            }
          : { state: "unavailable", label: "涨跌统计暂未拉到", message: "行情源还没返回全市场快照", canRetry: true }
      }
      status={{
        label: "上涨",
        // **真实数据**：getBreadth 服务端算好的计数。没有快照就是 null，
        // 页头就少这个药丸——不能拿 0 顶替「不知道」。
        value: breadth ? `${breadth.up} / ${breadth.down}` : null,
        tone: breadth ? (breadth.up > breadth.down ? "ok" : "warn") : "neutral",
      }}
      ornamentContent={
        flow && flow.stocksIn.length > 0 ? (
          <span className="text-[12px] tabular-nums">
            第一名 {flow.stocksIn[0]!.name} {fmtYi(flow.stocksIn[0]!.inflow)}
          </span>
        ) : (
          <span className="text-[12px]">资金榜暂不可用</span>
        )
      }
    >
      <SectionTabs ariaLabel="复盘" tabs={REVIEW_TABS} />
      <PixelHeader label="REVIEW // BREADTH" meta="涨跌分布 · 广度回答的是『多数票在涨还是多数在跌』" />
      <h1 className="font-display text-xl font-medium tracking-wide">市场总览</h1>
      <p className="-mt-1 max-w-[70ch] text-sm leading-relaxed text-muted">{marketLine}</p>

      {/* KPI 头版（效果图签名件）：五张卡全是服务端算好的真实计数 */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <HeroStat
          icon={<BarChart3 size={18} />}
          label="全市场 · 上涨 / 下跌"
          value={breadth ? `${breadth.up} / ${breadth.down}` : "—"}
          tone={breadth ? (breadth.up >= breadth.down ? "ok" : "warn") : "muted"}
          sub={breadth ? `上涨占比 ${upPct.toFixed(1)}% · 平盘 ${breadth.flat}` : "快照暂未拉到"}
        />
        <HeroStat
          icon={<Flame size={18} />}
          label="涨停 / 跌停"
          value={breadth ? `${breadth.limitUp} / ${breadth.limitDown}` : "—"}
          tone="muted"
          sub="情绪极值，涨跌停按板计"
        />
        <HeroStat
          icon={<Coins size={18} />}
          label="两市成交额"
          value={tapeAmount != null ? fmtYi(tapeAmount).replace("+", "") : "—"}
          tone={tapeChg == null ? "muted" : tapeChg >= 0 ? "ok" : "warn"}
          sub={tapeChg != null ? `较昨日 ${pctWord(tapeChg)}` : "昨日对照暂缺"}
        />
        <HeroStat
          icon={<LineChart size={18} />}
          label="沪深300"
          value={hs300 ? hs300.price.toFixed(2) : "—"}
          valueTone={hs300 ? (hs300.pct >= 0 ? "up" : "down") : undefined}
          tone={hs300 ? (hs300.pct >= 0 ? "ok" : "warn") : "muted"}
          sub={hs300 ? `${pctWord(hs300.pct)} · ${hs300.chg >= 0 ? "+" : ""}${hs300.chg.toFixed(2)}` : "指数暂未拉到"}
        />
        <HeroStat
          icon={<TrendingUp size={18} />}
          label="上证指数"
          value={shIdx ? shIdx.price.toFixed(2) : "—"}
          valueTone={shIdx ? (shIdx.pct >= 0 ? "up" : "down") : undefined}
          tone={shIdx ? (shIdx.pct >= 0 ? "ok" : "warn") : "muted"}
          sub={shIdx ? `${pctWord(shIdx.pct)} · ${shIdx.chg >= 0 ? "+" : ""}${shIdx.chg.toFixed(2)}` : "指数暂未拉到"}
        />
      </div>

      {/* 涨跌分布：占比条 + 11 桶直方图（口径钉在 slim-universe.test.ts） */}
      <Panel title="市场涨跌分布" note={buckets ? `${breadth!.total} 只 · 涨跌停按板单列` : undefined}>
        {!buckets ? (
          <StateBlock kind="empty" title="没拉到全市场快照" hint="行情源没返回。稍后再试。" />
        ) : (
          <div className="px-3.5 py-3">
            <div className="flex h-3 overflow-hidden rounded-full" role="img" aria-label={`上涨 ${upPct.toFixed(1)}%，平盘 ${flatPct.toFixed(1)}%，下跌 ${downPct.toFixed(1)}%`}>
              <div className="bg-up" style={{ width: `${upPct}%` }} />
              <div className="bg-muted/30" style={{ width: `${flatPct}%` }} />
              <div className="bg-down" style={{ width: `${downPct}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-xs tabular-nums">
              <span className="text-up">上涨 {breadth!.up} · {upPct.toFixed(1)}%</span>
              <span className="text-muted">平盘 {breadth!.flat}</span>
              <span className="text-down">下跌 {breadth!.down} · {downPct.toFixed(1)}%</span>
            </div>
            <div className="mt-5 flex h-40 items-end gap-1.5">
              {bucketRows.map((r) => (
                <div key={r.k} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] tabular-nums text-muted">{r.v}</span>
                  <div
                    className={`w-full rounded-t ${r.cls}`}
                    // px 高度：百分比高度在 auto 高的 flex 列里会塌成 0（2026-11-10 实测）
                    style={{ height: `${Math.max((r.v / bucketMax) * 120, r.v > 0 ? 4 : 2)}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-1.5">
              {bucketRows.map((r) => (
                <span key={r.k} className="min-w-0 flex-1 text-center text-[10px] text-muted">
                  {r.k}
                </span>
              ))}
            </div>
          </div>
        )}
      </Panel>

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
                <span className="shrink-0 text-[12px] tabular-nums text-muted">{n.time.slice(11, 16)}</span>
                <span className={"shrink-0 text-[12px] " + (n.tone === "good" ? "text-up" : n.tone === "bad" ? "text-down" : "text-muted")}>
                  {n.tone === "good" ? "利好" : n.tone === "bad" ? "利空" : "中性"}
                </span>
                <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg">{n.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* 页脚（效果图签名件）：数据源 + 免责 */}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-1 pt-3 text-[12px] text-muted">
        <span>数据来源：</span>
        {["上交所 · 深交所", "腾讯行情", "新浪（备源）", "东财"].map((s) => (
          <span key={s} className="rounded border border-line bg-surface px-2 py-0.5">
            {s}
          </span>
        ))}
        <span className="w-full sm:ml-auto sm:w-auto">行情有延迟，仅供研究参考，不构成投资建议。</span>
      </footer>
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
