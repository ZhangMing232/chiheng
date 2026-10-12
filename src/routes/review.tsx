/**
 * 这个文件是干什么的：
 * 「每日复盘」页。收盘后（或盘中）一页看完今天市场怎么样了：涨跌家数、
 * 指数、资金、快讯要点，再带上自己账本里今天的建仓和持仓表现。
 *
 * 你需要知道的：
 * 1. **这里全是规则拼装，不假装 AI**。每个数字都有出处（行情快照、资金接口、
 *    快讯流、自己的账本），学 Vibe-Research 的 daily-review 页的信息结构，
 *    但赤轨没有接入复盘大模型——写不出「AI 综合点评」，就只摆事实。
 * 2. 数据全部复用现有 server fn（getUniverse/getIndices/getFlow/getNews/
 *    getServerJournal），loader 里并发拉，拉不到的那块降级为空态带原因，
 *    不编造。
 * 3. 涨跌家数按 chg 的符号数（涨 > 0.001、跌 < -0.001，其余算平盘）；
 *    涨停跌停用 model.ts 的 limitTag（贴到板块涨跌停幅才算，留了 0.15 个点的缝）。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { Panel, Stat, pctClass } from "@/components/terminal";
import { signedPct, fmtWan } from "@/lib/market/format";
import { limitTag } from "@/lib/market/model";
import { readMarket } from "@/lib/market/flow";
import { shanghaiDate } from "@/lib/market/session";
import { getFlow, getIndices, getNews, getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import type { NewsItem, NewsTone } from "@/lib/market/news";

export const Route = createFileRoute("/review")({
  loader: async () => {
    const [universe, indices, flow, news, journal] = await Promise.all([
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getIndices().catch(() => []),
      getFlow().catch(() => null),
      getNews().catch(() => [] as NewsItem[]),
      getServerJournal().catch(() => ({ days: [], personal: false, why: "读账本失败" })),
    ]);
    return { universe, indices, flow, news, journal, date: shanghaiDate() };
  },
  component: Review,
});

const TONE_TEXT: Record<NewsTone, { label: string; className: string }> = {
  good: { label: "利好", className: "text-up" },
  bad: { label: "利空", className: "text-down" },
  flat: { label: "未表态", className: "text-muted" },
};

function Review() {
  const { universe, indices, flow, news, journal, date } = Route.useLoaderData();

  // 涨跌家数和涨跌停统计：直接扫全市场快照。快照不完整（partial/stale）时下面标明。
  const quotes = universe?.quotes ?? [];
  let up = 0;
  let down = 0;
  let flat = 0;
  let limitUp = 0;
  let limitDown = 0;
  for (const quote of quotes) {
    const chg = quote.chg;
    if (chg == null) continue;
    if (chg > 0.001) up += 1;
    else if (chg < -0.001) down += 1;
    else flat += 1;
    const tag = limitTag(quote);
    if (tag === "涨停") limitUp += 1;
    else if (tag === "跌停") limitDown += 1;
  }
  const known = up + down + flat;

  const tones = { good: 0, bad: 0, flat: 0 };
  for (const item of news) tones[item.tone] += 1;
  const headlines = news.slice(0, 8);

  // 账本：最新一天的建仓 + 所有未平仓的今日表现。拿不到就空态带原因。
  const days = journal.days;
  const latestDay = days[0] ?? null;
  const openTrades = days.flatMap((day) => day.trades.filter((trade) => trade.exit == null));
  const liveById = new Map(quotes.map((quote) => [quote.id, quote]));
  const openWithChg = openTrades
    .map((trade) => ({ trade, chg: liveById.get(trade.id)?.chg ?? null }))
    .filter((row): row is { trade: (typeof openTrades)[number]; chg: number } => row.chg != null);
  const avgOpenChg =
    openWithChg.length === 0
      ? null
      : openWithChg.reduce((sum, row) => sum + row.chg, 0) / openWithChg.length;

  const hs300 = indices.find((index) => index.name.includes("沪深300")) ?? null;
  const marketLines = flow ? readMarket(flow.market) : [];

  return (
    <Frame
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">每日复盘</span>
          <span className="tabular-nums">{date}</span>
          {universe ? (
            <span>
              快照 {new Date(universe.asOf).toLocaleTimeString("zh-CN", { hour12: false })}
              {universe.stale ? " · 已过期" : ""}
              {universe.partial ? " · 不完整" : ""}
            </span>
          ) : (
            <span>行情快照拉不到</span>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* 第一屏：今天市场偏多头还是偏空头。红涨绿跌，家数比点位更诚实（指数会被权重股绑架）。 */}
        <Panel
          title="涨跌家数"
          note={known > 0 ? <span>全市场 {quotes.length} 只里有行情的 {known} 只</span> : undefined}
          bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-4"
        >
          <Stat label="上涨" value={known === 0 ? "—" : String(up)} className="bg-surface text-up" />
          <Stat label="下跌" value={known === 0 ? "—" : String(down)} className="bg-surface text-down" />
          <Stat label="涨停" value={String(limitUp)} className="bg-surface" hint="贴到板块涨跌停幅" />
          <Stat label="跌停" value={String(limitDown)} className="bg-surface" />
        </Panel>
        {known > 0 ? (
          <div className="flex h-2 overflow-hidden rounded bg-surface-2" aria-label="涨跌分布条">
            <span className="bg-up" style={{ width: `${(up / known) * 100}%` }} />
            <span className="bg-line" style={{ width: `${(flat / known) * 100}%` }} />
            <span className="bg-down" style={{ width: `${(down / known) * 100}%` }} />
          </div>
        ) : null}

        {indices.length > 0 ? (
          <Panel title="指数" bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {indices.map((index) => (
              <Stat
                key={index.id}
                label={index.name}
                value={signedPct(index.pct)}
                tone={pctClass(index.pct)}
                className="bg-surface"
              />
            ))}
          </Panel>
        ) : (
          <Panel title="指数">
            <StateBlock kind="empty" title="指数暂时拉不到" hint="刷新重试；不复盘指数也要看家数。" />
          </Panel>
        )}

        {flow ? (
          <Panel
            title="资金"
            note={
              <span>
                主力净额 · {new Date(flow.asOf).toLocaleTimeString("zh-CN", { hour12: false })}
              </span>
            }
            bodyClassName="grid grid-cols-2 gap-px bg-line"
          >
            {flow.market.map((part) => (
              <Stat
                key={part.name}
                label={`${part.name}主力`}
                value={fmtWan(part.main)}
                tone={part.main > 0 ? "text-up" : part.main < 0 ? "text-down" : undefined}
                className="bg-surface"
                hint={`超大 ${fmtWan(part.super)} · 大单 ${fmtWan(part.big)}`}
              />
            ))}
          </Panel>
        ) : (
          <Panel title="资金">
            <StateBlock kind="empty" title="资金数据暂时拉不到" hint="东财资金接口超时或限流，刷新重试。" />
          </Panel>
        )}
        {marketLines.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded border border-line bg-surface px-3.5 py-2 text-xs leading-relaxed text-muted">
            {marketLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        <Panel
          title="快讯要点"
          note={<span>今天 {news.length} 条 · 利好 {tones.good} · 利空 {tones.bad}</span>}
        >
          {headlines.length === 0 ? (
            <StateBlock kind="empty" title="今天还没有快讯" hint="盘中大约一分钟更新一次。" />
          ) : (
            <ul>
              {headlines.map((item) => (
                <li key={item.id} className="border-b border-line px-3.5 py-2 last:border-0">
                  <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
                    <span className={TONE_TEXT[item.tone].className}>{TONE_TEXT[item.tone].label}</span>
                    <span className="tabular-nums">{item.time.slice(5, 16)}</span>
                  </div>
                  <p className="mt-0.5 text-sm">{item.title}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="我的账本今天"
          note={latestDay ? <span>最新建仓日 {latestDay.date}</span> : undefined}
        >
          {journal.days.length === 0 ? (
            <StateBlock
              kind="empty"
              title="今天没有建仓记录"
              hint={journal.why ?? "策略打到买入价才记一笔；有持仓时这里会带上它们今天的表现。"}
            />
          ) : (
            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              <Stat
                label="最新一天建仓"
                value={latestDay ? `${latestDay.trades.length} 笔` : "—"}
                className="bg-surface"
                hint={latestDay?.signalTime}
              />
              <Stat label="当前在拿" value={`${openTrades.length} 只`} className="bg-surface" />
              <Stat
                label="持仓今日均值"
                value={avgOpenChg == null ? "—" : signedPct(avgOpenChg)}
                tone={pctClass(avgOpenChg)}
                className="bg-surface"
                hint={openWithChg.length > 0 ? `${openWithChg.length} 只取到行情` : "拿不到现价"}
              />
              <Stat
                label="沪深300 今日"
                value={hs300 ? signedPct(hs300.pct) : "—"}
                tone={hs300 ? pctClass(hs300.pct) : undefined}
                className="bg-surface"
                hint="持仓均值跑赢它才算真赚"
              />
            </div>
          )}
          {journal.days.length > 0 ? (
            <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted">
              明细在 <Link to="/positions" className="text-brand hover:underline">策略追踪</Link>。
              这里只做日内对照，不改任何账。
            </p>
          ) : null}
        </Panel>

        <p className="px-1 text-xs leading-relaxed text-muted">
          这一页是规则拼装的盘面事实：家数来自行情快照、资金来自东财、快讯按标题用词分态度。
          赤轨没有接入复盘大模型，写不出「AI 综合点评」——摆出事实，判断留给你。
        </p>
      </div>
    </Frame>
  );
}
