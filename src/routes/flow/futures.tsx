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
import { FlowDerivedTabs, FlowSectionTabs, Futures } from "@/components/flow-sections";
import { drawFuturesPoster } from "@/lib/market/extra-posters";
import { getIndexFutures } from "@/lib/market/quotes.functions";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

export const Route = createFileRoute("/flow/futures")({
  loader: async () => ({ futures: await getIndexFutures().catch(() => null) }),
  component: FlowFuturesPage,
});

function FlowFuturesPage() {
  const { futures } = Route.useLoaderData();
  return (
    <Frame wide aside="资金流向 · 期指" decorHeader={false}>
      <FlowSectionTabs />
      <PixelHeader label="FLOW // DERIVED · FUTURES" meta="期指基差看升贴水，别当方向信号" />
      <PixelSummary
        label="FLOW // FUTURES"
        note="基差看升贴水，别当方向信号"
        stats={[
          { label: "合约数", value: futures?.rows?.length ?? null, tone: "brand", hero: true },
          { label: "多单合计", value: futures?.rows?.length ? futures.rows.reduce((n, r) => n + r.longLots, 0).toLocaleString("zh-CN") : null, tone: "up" },
          { label: "空单合计", value: futures?.rows?.length ? futures.rows.reduce((n, r) => n + r.shortLots, 0).toLocaleString("zh-CN") : null, tone: "down" },
        ]}
      />
      <div className="mb-2"><FlowDerivedTabs active="futures" /></div>
      <PosterButton draw={() => drawFuturesPoster(futures ?? { date: "", rows: [] })} />
      <Futures book={futures} />
    </Frame>
  );
}
