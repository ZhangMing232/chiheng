/**
 * 这个文件是干什么的：
 * 「资金流向」区的「大盘资金」子页（/flow/market）。主力/超大单/大单/中单/
 * 小单/散户在两市各自的净流入，加上规则汇总读数和「另外三类」交代。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 主力不是机构、北向没有盘中净流入——口径写在块里，不编。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FlowSectionTabs, Market } from "@/components/flow-sections";
import { getFlow } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/flow/market")({
  loader: async () => ({ book: await getFlow().catch(() => null) }),
  component: FlowMarketPage,
});

function FlowMarketPage() {
  const { book } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 大盘资金">
      <FlowSectionTabs />
      {book ? (
        <Market parts={book.market} />
      ) : (
        <p className="text-sm text-muted">大盘资金暂时拉不下来，刷新重试。</p>
      )}
    </Frame>
  );
}
