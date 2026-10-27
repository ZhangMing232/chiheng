/**
 * 这个文件是干什么的：
 * 「资金流向」区的主页（/flow/）。把「概览 / 走势 / 大盘资金」三块合并成一页：
 * 一排四个数字（涨跌家数/两市成交额/主力/北向）+ 全市场资金汇总图 + 上证分时走势 + 大盘资金流向。
 *
 * 你需要知道的：
 * 1. 2026-10-23 用户要求合并：原来拆成 /flow/、/flow/trend、/flow/market 三个子页，
 *    现在合成这一页（走势、大盘资金两个子页已删）。
 * 2. 这里只展示。北向没有盘中净流入。生成图片不会改变买入价。
 * 3. 涨跌家数在服务端算完再下发；全量快照不进 SSR HTML（~5300 只 1.2MB，手机会卡死）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { INDEX_LABEL } from "@/components/screener/screener";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { drawFlowPoster } from "@/lib/market/flow-poster";
import { getFlow, getIndices, getTrend, getUniverse } from "@/lib/market/quotes.functions";
import { marketBreadth } from "@/lib/market/slim-universe";
import type { IndexQuote } from "@/lib/market/types";
import { cx, flowAmount, FlowSectionTabs, Market, Overview, TrendChart } from "@/components/flow-sections";

export const Route = createFileRoute("/review/flow/")({
  loader: async () => {
    const [book, indices, universe, trend] = await Promise.all([
      getFlow().catch((error: unknown) => ({ error })),
      getIndices().catch(() => [] as IndexQuote[]),
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getTrend({ data: { id: "sh000001" } }).catch(() => null),
    ]);
    // 涨跌家数/涨跌停在服务端算完再下发，全量快照不进 SSR HTML。
    const breadth = marketBreadth(universe?.quotes ?? []);
    const hasBreadth = (universe?.total ?? 0) > 0;
    if (book && typeof book === "object" && "error" in book) {
      return {
        book: null,
        indices,
        breadth,
        hasBreadth,
        trend,
        error: book.error instanceof Error ? book.error.message : "资金流向暂时拉不下来",
      };
    }
    return { book, indices, breadth, hasBreadth, trend, error: null as string | null };
  },
  component: FlowOverviewPage,
});

function FlowOverviewPage() {
  const { book, indices, breadth, hasBreadth, trend, error } = Route.useLoaderData();

  return (
    <Frame wide
      extra={
        indices.length > 0 ? (
          <div className="flex gap-5 overflow-x-auto scroll-slim pb-2">
            {indices.map((item) => (
              <div key={item.id} className="flex shrink-0 items-baseline gap-1.5 text-xs">
                <span className="text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                <span className={cx("tabular-nums", toneClass(item.pct))}>{item.price > 0 ? fmtPrice(item.price) : "—"}</span>
                <span className={cx("font-medium tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
              </div>
            ))}
          </div>
        ) : null
      }
      ornamentContent={
        // **真实数据**：book.stocksIn 是东财给的主力净流入榜（已去新股/ST）。
        // 只报第一名——「第一是谁 + 多少钱」比「前 N 合计」更直观。
        book && book.stocksIn.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            净流入第一 {book.stocksIn[0]!.name} {flowAmount(book.stocksIn[0]!.inflow)}
          </span>
        ) : (
          <span className="text-[11px]">资金榜暂不可用</span>
        )
      }
    >
      <FlowSectionTabs />
      <p className="text-sm text-muted">这里只展示，看资金不会改变买入价。</p>
      {error ? <p className="text-sm text-up">{error}</p> : null}
      {book ? (
        <>
          <PosterButton draw={() => drawFlowPoster(book)} />
          <Overview tape={book.tape} parts={book.market} north={book.north} breadth={breadth} hasBreadth={hasBreadth} />
          {trend ? <TrendChart trend={trend} sectors={book.sectorsIn} /> : <p className="text-sm text-muted">分时暂时拉不下来，刷新重试。</p>}
          <Market parts={book.market} />
        </>
      ) : null}
    </Frame>
  );
}
