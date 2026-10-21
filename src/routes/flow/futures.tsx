/**
 * 这个文件是干什么的：
 * 「资金流向」区的「期指」子页（/flow/futures）。中金所前 20 名会员的
 * 股指期货多空单持仓。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 公布的是代客持仓，不是单独的机构账户。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { FlowSectionTabs, Futures } from "@/components/flow-sections";
import { drawFuturesPoster } from "@/lib/market/extra-posters";
import { getIndexFutures } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/flow/futures")({
  loader: async () => ({ futures: await getIndexFutures().catch(() => null) }),
  component: FlowFuturesPage,
});

function FlowFuturesPage() {
  const { futures } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 期指">
      <FlowSectionTabs />
      <PosterButton draw={() => drawFuturesPoster(futures ?? { date: "", rows: [] })} />
      <Futures book={futures} />
    </Frame>
  );
}
