/**
 * 这个文件是干什么的：
 * 「资金流向」区的「概览」子页（/flow/）。一排四个数字看完今天资金面：
 * 涨跌家数、两市成交额、主力、北向，外加全市场资金汇总图。
 *
 * 你需要知道的：
 * 1. 2026-10-21 从整页大拆页：原来这一页里向下排开的走势/大盘资金/北向/行业/
 *    个股/游资/收盘快照/两融/期指都各自成了 /flow 下的子页面（见
 *    components/flow-sections.tsx 的 FlowSectionTabs），这一页只留概览。
 * 2. 这里只展示。北向没有盘中净流入。生成图片不会改变买入价。
 * 3. 涨跌家数在服务端算完再下发；全量快照不进 SSR HTML（~5300 只 1.2MB，手机会卡死）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { INDEX_LABEL } from "@/components/screener/screener";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { drawFlowPoster } from "@/lib/market/flow-poster";
import { getFlow, getIndices, getUniverse } from "@/lib/market/quotes.functions";
import { marketBreadth } from "@/lib/market/slim-universe";
import type { IndexQuote } from "@/lib/market/types";
import { cx, FlowSectionTabs, Overview } from "@/components/flow-sections";

export const Route = createFileRoute("/flow/")({
  loader: async () => {
    const [book, indices, universe] = await Promise.all([
      getFlow().catch((error: unknown) => ({ error })),
      getIndices().catch(() => [] as IndexQuote[]),
      getUniverse({ data: { refresh: false } }).catch(() => null),
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
        error: book.error instanceof Error ? book.error.message : "资金流向暂时拉不下来",
      };
    }
    return { book, indices, breadth, hasBreadth, error: null as string | null };
  },
  component: FlowOverviewPage,
});

function FlowOverviewPage() {
  const { book, indices, breadth, hasBreadth, error } = Route.useLoaderData();

  return (
    <Frame
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
    >
      <FlowSectionTabs />
      <p className="text-sm text-muted">这里只展示，看资金不会改变买入价。</p>
      {error ? <p className="text-sm text-up">{error}</p> : null}
      {book ? (
        <>
          <PosterButton draw={() => drawFlowPoster(book)} />
          <Overview tape={book.tape} parts={book.market} north={book.north} breadth={breadth} hasBreadth={hasBreadth} />
        </>
      ) : null}
    </Frame>
  );
}
