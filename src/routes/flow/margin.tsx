/**
 * 这个文件是干什么的：
 * 「资金流向」区的「两融」子页（/flow/margin）。全市场杠杆总账 + 融资余额
 * 头部个股 + 缺口显式。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 数据来自东财两融明细的落盘快照（T+1 发布，收盘后跑抓取脚本更新），不是实时。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FlowDerivedTabs, FlowSectionTabs, Margin } from "@/components/flow-sections";
import { getMargin } from "@/lib/market/quotes.functions";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/flow/margin")({
  loader: async () => ({ margin: await getMargin().catch(() => null) }),
  component: FlowMarginPage,
});

function FlowMarginPage() {
  const { margin } = Route.useLoaderData();
  return (
    <Frame wide aside="资金流向 · 两融">
      <FlowSectionTabs />
      <PixelHeader label="FLOW // DERIVED · MARGIN" meta="两融余额是 T-1 口径，不是实时" />
      <div className="mb-2"><FlowDerivedTabs active="margin" /></div>
      <Margin data={margin} />
    </Frame>
  );
}
