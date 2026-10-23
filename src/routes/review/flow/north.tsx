/**
 * 这个文件是干什么的：
 * 「资金流向」区的「北向」子页（/flow/north）。沪股通/深股通最近一个已公布
 * 交易日的成交额。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 盘中净流入不再公布，收盘后也没有净买入——这里只有成交额，不编净额。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FlowSectionTabs, North } from "@/components/flow-sections";
import { getFlow } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/review/flow/north")({
  loader: async () => ({ book: await getFlow().catch(() => null) }),
  component: FlowNorthPage,
});

function FlowNorthPage() {
  const { book } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 北向">
      <FlowSectionTabs />
      <North legs={book?.north ?? []} />
    </Frame>
  );
}
