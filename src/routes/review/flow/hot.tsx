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
import { FlowSectionTabs, Hot } from "@/components/flow-sections";
import { drawHotPoster } from "@/lib/market/extra-posters";
import { getHotMoney } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/review/flow/hot")({
  loader: async () => ({ hot: await getHotMoney().catch(() => null) }),
  component: FlowHotPage,
});

function FlowHotPage() {
  const { hot } = Route.useLoaderData();
  return (
    <Frame aside="资金流向 · 游资">
      <FlowSectionTabs />
      <PosterButton draw={() => drawHotPoster(hot ?? { date: "", seats: [] })} />
      <Hot book={hot} />
    </Frame>
  );
}
