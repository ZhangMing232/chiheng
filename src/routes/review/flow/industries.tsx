/**
 * 这个文件是干什么的：
 * 「资金流向」区的「行业」子页（/flow/industries）。行业净流入/净流出两个榜
 * （腾讯资金榜，盘中约一分钟更新）。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 这里是**实时资金流向**；月度的温度计在「板块」子页（/flow/sectors），两页不是一回事。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { flowAmount, FlowSectionTabs, List } from "@/components/flow-sections";
import { getFlow } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/review/flow/industries")({
  loader: async () => ({ book: await getFlow().catch(() => null) }),
  component: FlowIndustriesPage,
});

function FlowIndustriesPage() {
  const { book } = Route.useLoaderData();
  return (
    <Frame
      aside="资金流向 · 行业"
      ornamentContent={
        book == null ? (
          <span className="text-[11px]">行业资金榜没拉到</span>
        ) : book.sectorsIn.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            行业流入第一 {book.sectorsIn[0]!.name} {flowAmount(book.sectorsIn[0]!.inflow)}
          </span>
        ) : (
          <span className="text-[11px]">今天没有行业资金榜</span>
        )
      }
    >
      <FlowSectionTabs />
      {book ? (
        <div className="flex flex-col gap-3">
          <List title="行业净流入" rows={book.sectorsIn} />
          <List title="行业净流出" rows={book.sectorsOut} />
        </div>
      ) : (
        <p className="text-sm text-muted">行业资金暂时拉不下来，刷新重试。</p>
      )}
    </Frame>
  );
}
