/**
 * 这个文件是干什么的：
 * 「资金流向」区的「个股」子页（/flow/stocks）。个股净流入/净流出两个榜，
 * 股票名可点开个股抽屉。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 选股页「看资金流向」按钮直接落到本页（原来带 #flow-stocks 锚点跳旧整页）。
 * - 榜单已去掉新股和 ST。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FlowSectionTabs, List } from "@/components/flow-sections";
import { StockName } from "@/components/screener/stock-name";
import { getFlow } from "@/lib/market/quotes.functions";
import type { FlowRow } from "@/lib/market/flow";

export const Route = createFileRoute("/review/flow/stocks")({
  loader: async () => ({ book: await getFlow().catch(() => null) }),
  component: FlowStocksPage,
});

function renderStockName(row: FlowRow) {
  return <StockName id={row.id} name={row.name} source="flow" />;
}

function FlowStocksPage() {
  const { book } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 个股">
      <FlowSectionTabs />
      {book ? (
        <div className="flex flex-col gap-3">
          <List title="个股净流入" rows={book.stocksIn} hint="已去掉新股和 ST。" renderName={renderStockName} />
          <List title="个股净流出" rows={book.stocksOut} hint="已去掉新股和 ST。" renderName={renderStockName} />
        </div>
      ) : (
        <p className="text-sm text-muted">个股资金暂时拉不下来，刷新重试。</p>
      )}
    </Frame>
  );
}
