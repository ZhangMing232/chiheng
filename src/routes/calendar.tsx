/**
 * 这个文件是干什么的：
 * 「日历」页——未来这些天，哪笔持仓到期。
 *
 * 对标 Vibe-Research 的数据日历（它第 15 层，混着法定披露期限和规则推算的下一档）。
 * 赤轨能给的只有一块真实内容：**账本里未平仓持仓的计划卖出日**。别的（财报披露
 * 期限、宏观数据发布）都没有全市场数据，不做——做出来的日历是空的，不如不做。
 *
 * 你需要知道的（纪律）：
 * 1. **到期日是计划卖出日，不是承诺**。中途碰到止损止盈会提前卖，所以日历上的
 *    某天写着「到期」，意思是「如果没提前触发，这天到期」。
 * 2. **跨年算不出来**：baostock 的交易日历只给到当年 12-31（实测要 2027 年的
 *    没有）。算不出的笔进缺口，**不拿最后一天顶替**——那会让人以为所有跨年
 *    持仓都在年底到期。
 * 3. 数交易日从买入日的**下一天**开始（T+1），和 exitFill 同一口径。
 * 4. 只描述计划，不给买卖建议。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { getCalendar } from "@/lib/market/calendar.functions";
import { getBuybacks, getForecasts, getHolderTrades, getSurveys } from "@/lib/market/events.functions";
import { getServerJournal } from "@/lib/market/quotes.functions";
import { fmtPrice } from "@/lib/market/format";
import { EventsPanel } from "@/routes/events";

export const Route = createFileRoute("/calendar")({
  // 页内 tab（三级导航）：plan = 持仓到期计划（默认），events = 公司事件
  // （业绩预告/股东增减持/机构调研/股票回购四类，面板内还有二级 tab）。
  // /events 旧路由重定向到这里（2026-10-16 导航整合）。
  validateSearch: (search: Record<string, unknown>): { tab: "plan" | "events" } => ({
    tab: search.tab === "events" ? "events" : "plan",
  }),
  loader: async () => {
    const journal = await getServerJournal().catch(() => ({ days: [] as never[] }));
    // 四类公司事件并发拉（2026-10-16 起了三类）。任何一类失败不影响别的——
    // 页面按类各自显示「没拉到 + 原因」。
    const [calendar, forecasts, holders, surveys, buybacks] = await Promise.all([
      getCalendar({ data: { days: journal.days as never[] } }).catch(() => null),
      getForecasts({ data: { limit: 80 } }).catch(() => null),
      getHolderTrades({ data: { limit: 60 } }).catch(() => null),
      getSurveys({ data: { limit: 60 } }).catch(() => null),
      getBuybacks({ data: { limit: 60 } }).catch(() => null),
    ]);
    return { calendar, forecasts, holders, surveys, buybacks };
  },
  component: CalendarPage,
});

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekday(date: string): string {
  const t = new Date(`${date}T00:00:00+08:00`).getTime();
  return Number.isFinite(t) ? WEEK[new Date(t).getUTCDay()] ?? "" : "";
}

function CalendarPage() {
  const { calendar, forecasts, holders, surveys, buybacks } = Route.useLoaderData();
  const { tab } = Route.useSearch();

  /** 页内三级导航：两个 tab 一条排，选中项用品牌色描边（和事件页的筛选按钮同语汇）。 */
  const tabs = (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">日历与事件</span>
      {(
        [
          { key: "plan", label: "持仓到期" },
          { key: "events", label: "公司事件" },
        ] as const
      ).map((t) => (
        <Link
          key={t.key}
          to="/calendar"
          search={{ tab: t.key }}
          aria-current={tab === t.key ? "page" : undefined}
          className={
            "rounded border px-2.5 py-1 text-xs transition " +
            (tab === t.key ? "border-brand font-medium text-fg" : "border-line text-muted hover:text-fg")
          }
        >
          {t.label}
        </Link>
      ))}
    </div>
  );

  if (tab === "events") {
    return (
      <Frame aside={tabs}>
        <EventsPanel data={forecasts} holders={holders} surveys={surveys} buybacks={buybacks} />
      </Frame>
    );
  }

  if (!calendar) {
    return (
      <Frame aside={tabs}>
        <Panel title="日历" note="没读到">
          <StateBlock kind="empty" title="日历暂时打不开" hint="交易日历或服务端账本没读到。交易日历要跑 python3 scripts/fetch-calendar.py。" />
        </Panel>
      </Frame>
    );
  }

  const { view, open, today } = calendar;
  const total = view.events.length;

  return (
    <Frame aside={tabs}>
      <Panel
        title="日历"
        note={`${open} 笔在拿 · ${total} 笔排得上到期日${view.overdue.length > 0 ? ` · ${view.overdue.length} 笔该结没结` : ""}${view.rangeEnd ? ` · 日历给到 ${view.rangeEnd}` : ""}`}
      >
        <div className="border-b border-line px-3.5 py-2 text-[11px] text-muted">
          这天写「到期」是计划卖出日：持有满 N 个交易日就该结了。中途碰到止损止盈会提前卖，
          所以它不是承诺。数交易日从买入日的第二天开始（T+1）。
        </div>

        {view.overdue.length > 0 ? (
          <div className="border-b border-line px-3.5 py-2">
            <div className="mb-1 flex items-center gap-2">
              <Tag tone="warn">该结没结</Tag>
              <span className="text-[11px] text-muted">
                已经过了计划到期日、账本里却还是未平仓。要么卡住了（K 线里找不到买入日），要么行情拉不下来没结算——记账进程收盘后会把它们记成「结算不出来」并打日志。
              </span>
            </div>
            <table className="data-table w-full">
              <caption className="sr-only">已过计划到期日但仍未平仓的持仓</caption>
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass("text-left")}>标的</th>
                  <th className={thClass("text-left")}>策略</th>
                  <th className={thClass()}>买入价</th>
                  <th className={thClass()}>计划到期</th>
                  <th className={thClass("text-left")}>建仓日</th>
                </tr>
              </thead>
              <tbody>
                {view.overdue.map((e) => (
                  <tr key={`${e.id}-${e.date}`} className="border-b border-line/60">
                    <td className={tdClass("text-left")}>
                      <span className="text-fg">{e.name}</span>
                      <span className="ml-1.5 text-[11px] text-muted">{e.id}</span>
                    </td>
                    <td className={tdClass("text-left text-muted")}>{e.style || "—"}</td>
                    <td className={tdClass()}>{fmtPrice(e.entry)}</td>
                    <td className={tdClass("whitespace-nowrap")}>{e.date}</td>
                    <td className={tdClass("text-left text-muted")}>{e.buyDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {view.timeline.length === 0 ? (
          <StateBlock
            kind="empty"
            title="未来这段时间没有到期安排"
            hint={
              open === 0
                ? "账本里现在没有未平仓的持仓。建仓之后（策略选股页或记账进程自动建），这里就会排出到期日。"
                : "持仓的到期日都不在日历范围内，或者交易日历没抓过。跑 python3 scripts/fetch-calendar.py 再看看。"
            }
          />
        ) : (
          <div className="divide-y divide-line/60">
            {view.timeline.map((slot) => (
              <div key={slot.date} className={"px-3.5 py-2 " + (slot.date === today ? "bg-brand-soft/20" : "")}>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm text-fg">{slot.date}</span>
                  <span className="text-[11px] text-muted">{weekday(slot.date)}</span>
                  {slot.date === today ? <Tag tone="brand">今天</Tag> : null}
                  <span className="ml-auto text-[11px] text-muted">
                    {slot.events.length === 0 ? "没有安排" : `${slot.events.length} 笔到期`}
                  </span>
                </div>
                {slot.events.length > 0 ? (
                  <table className="data-table mt-1.5 w-full">
                    <caption className="sr-only">{slot.date} 到期的持仓</caption>
                    <thead>
                      <tr className="border-b border-line">
                        <th className={thClass("text-left")}>标的</th>
                        <th className={thClass("text-left")}>策略</th>
                        <th className={thClass()}>买入价</th>
                        <th className={thClass()}>持有</th>
                        <th className={thClass("text-left")}>建仓日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slot.events.map((e) => (
                        <tr key={`${e.date}-${e.id}`} className="border-b border-line/60">
                          <td className={tdClass("text-left")}>
                            <span className="text-fg">{e.name}</span>
                            <span className="ml-1.5 text-[11px] text-muted">{e.id}</span>
                          </td>
                          <td className={tdClass("text-left text-muted")}>{e.style || "—"}</td>
                          <td className={tdClass()}>{fmtPrice(e.entry)}</td>
                          <td className={tdClass("text-muted")}>{e.hold} 个交易日</td>
                          <td className={tdClass("text-left text-muted")}>{e.buyDate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {view.gaps.length > 0 ? <GapList items={view.gaps} /> : null}
      </Panel>
    </Frame>
  );
}
