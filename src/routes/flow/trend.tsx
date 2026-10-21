/**
 * 这个文件是干什么的：
 * 「资金流向」区的「走势」子页（/flow/trend）。上证指数分时，灰虚线昨收，
 * 板块标签是当前主力净流入靠前的行业快照。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 板块标签是拉走势那一刻的资金快照，不是历史回放。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FlowSectionTabs, TrendChart } from "@/components/flow-sections";
import { getFlow, getTrend } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/flow/trend")({
  loader: async () => {
    const [trend, book] = await Promise.all([
      getTrend({ data: { id: "sh000001" } }).catch(() => null),
      getFlow().catch(() => null),
    ]);
    return { trend, sectorsIn: book?.sectorsIn ?? [] };
  },
  component: FlowTrendPage,
});

function FlowTrendPage() {
  const { trend, sectorsIn } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 走势">
      <FlowSectionTabs />
      {trend ? (
        <TrendChart trend={trend} sectors={sectorsIn} />
      ) : (
        <p className="text-sm text-muted">分时暂时拉不下来，刷新重试。</p>
      )}
    </Frame>
  );
}
