/**
 * 这个文件是干什么的：
 * 「公司事件」子页——业绩预告、股东增减持、机构调研、股票回购、股权质押、
 * 新股申购六类事件型数据。2026-10-21 从日历页（/calendar?tab=events）搬进
 * 「复盘」区，和每日复盘、信号同一个页面的子页。
 *
 * 你需要知道的（纪律都写在面板里，这里记架构）：
 * - 面板本体 EventsPanel 仍在 routes/events.tsx 导出，那边同时保留着 /events
 *   旧路由的重定向。
 * - 六类事件并发拉，任何一类失败不影响别的——页面按类各自显示「没拉到 + 原因」。
 * - 这一页只摆「谁在用真金白银投票」的事实，不给买卖建议。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs } from "@/components/section-tabs";
import { getBuybacks, getForecasts, getHolderTrades, getIpos, getPledges, getSurveys } from "@/lib/market/events.functions";
import { EventsPanel } from "@/routes/events";

export const Route = createFileRoute("/review/events")({
  loader: async () => {
    // 六类并发拉（任何一类失败不影响别的——页面按类各自显示「没拉到 + 原因」）。
    const [forecasts, holders, surveys, buybacks, pledges, ipos] = await Promise.all([
      getForecasts({ data: { limit: 80 } }).catch(() => null),
      getHolderTrades({ data: { limit: 60 } }).catch(() => null),
      getSurveys({ data: { limit: 60 } }).catch(() => null),
      getBuybacks({ data: { limit: 60 } }).catch(() => null),
      getPledges({ data: { limit: 80 } }).catch(() => null),
      getIpos({ data: { limit: 40 } }).catch(() => null),
    ]);
    return { forecasts, holders, surveys, buybacks, pledges, ipos };
  },
  component: ReviewEventsPage,
});

function ReviewEventsPage() {
  const { forecasts, holders, surveys, buybacks, pledges, ipos } = Route.useLoaderData();
  return (
    <Frame aside="公司事件">
      <SectionTabs
        ariaLabel="复盘"
        tabs={[
          { to: "/review/", label: "每日复盘" },
          { to: "/review/flow/", label: "资金流向" },
          { to: "/review/signals", label: "信号" },
          { to: "/review/events", label: "公司事件" },
        ]}
      />
      <EventsPanel
        data={forecasts}
        holders={holders}
        surveys={surveys}
        buybacks={buybacks}
        pledges={pledges}
        ipos={ipos}
      />
    </Frame>
  );
}
