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
import { flowAmount, FlowSectionTabs, List } from "@/components/flow-sections";
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
    <Frame wide
      aside="资金流向 · 个股"
      ornamentContent={
        // **真实数据**：净流入榜第一名。流入榜空就看流出榜——
        // 不拿空榜凑一句话，也不显示「0」冒充有数据。
        book == null ? (
          <span className="text-[11px]">资金榜没拉到</span>
        ) : book.stocksIn.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            流入第一 {book.stocksIn[0]!.name} {flowAmount(book.stocksIn[0]!.inflow)}
          </span>
        ) : book.stocksOut.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            流出第一 {book.stocksOut[0]!.name} {flowAmount(book.stocksOut[0]!.inflow)}
          </span>
        ) : (
          <span className="text-[11px]">今天没有个股资金榜</span>
        )
      }
    >
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
