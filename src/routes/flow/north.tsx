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
import { FlowDerivedTabs, FlowSectionTabs, North } from "@/components/flow-sections";
import { getFlow } from "@/lib/market/quotes.functions";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

export const Route = createFileRoute("/flow/north")({
  loader: async () => ({ book: await getFlow().catch(() => null) }),
  component: FlowNorthPage,
});

function FlowNorthPage() {
  const { book } = Route.useLoaderData();
  return (
    <Frame wide aside="资金流向 · 北向">
      <FlowSectionTabs />
      <PixelHeader label="FLOW // DERIVED · NORTH" meta="北向只有成交额，净买入盘中不再公布" />
      <PixelSummary
        label="FLOW // NORTH"
        note="只公布成交额 · 盘中净买入不再披露"
        stats={[
          { label: book?.north?.[0]?.name ?? "沪股通", value: book?.north?.[0] ? `${(book.north[0].amount / 1e4).toFixed(1)}亿` : null, tone: "up", hero: true, hint: "成交额" },
          { label: book?.north?.[1]?.name ?? "深股通", value: book?.north?.[1] ? `${(book.north[1].amount / 1e4).toFixed(1)}亿` : null, tone: "up", hint: "成交额" },
        ]}
      />
      <div className="mb-2"><FlowDerivedTabs active="north" /></div>
      <North legs={book?.north ?? []} />
    </Frame>
  );
}
