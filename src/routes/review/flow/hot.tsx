/**
 * 这个文件是干什么的：
 * 「资金流向」区的「游资」子页（/flow/hot）。龙虎榜席位：一行一个席位，
 * 红净买绿净卖，收盘后才有。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 对得上的席位才用别名，其余用路名；机构和拉萨放最后。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { flowAmount, FlowSectionTabs, Hot } from "@/components/flow-sections";
import { drawHotPoster } from "@/lib/market/extra-posters";
import { getHotMoney } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/review/flow/hot")({
  loader: async () => ({ hot: await getHotMoney().catch(() => null) }),
  component: FlowHotPage,
});

function FlowHotPage() {
  const { hot } = Route.useLoaderData();
  return (
    <Frame wide
      aside="资金流向 · 游资"
      ornamentContent={
        // **真实数据**：龙虎榜席位净买第一名（席位榜按金额排，第一个就是今天最大的）。
        // 「猛」不是跟买理由——这句话页面上本来就写着，装饰件只报数。
        hot && hot.seats.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            最猛席位 {hot.seats[0]!.name} {flowAmount(hot.seats[0]!.netWan)}
          </span>
        ) : (
          <span className="text-[11px]">今天没有龙虎榜席位数据</span>
        )
      }
    >
      <FlowSectionTabs />
      <PosterButton draw={() => drawHotPoster(hot ?? { date: "", seats: [] })} />
      <Hot book={hot} />
    </Frame>
  );
}
