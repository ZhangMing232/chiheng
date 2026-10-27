/**
 * 这个文件是干什么的：
 * 「资金流向」区的「收盘快照」子页（/flow/close）。通达信盘后包的收盘定盘数据：
 * 全市场成交额 TOP + 北交所单列。
 *
 * 你需要知道的：
 * - 2026-10-21 由资金流向整页拆出（原来是一页内的滚动锚点，用户要求改真实子页面）。
 * - 它是收盘后定盘数据（不是盘中快照），含北交所——腾讯和新浪都挡掉 bj，别处拿不到。
 * - 数据截至哪天不一定是今天：盘后包收盘后数小时才发布，且是增量（每天要跑
 *   `python3 scripts/fetch-tdx-package.py`），中间可能缺好几天。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { CloseSnapshotPanel, FlowSectionTabs } from "@/components/flow-sections";
import { getCloseSnapshot } from "@/lib/market/tdx-daily.functions";

export const Route = createFileRoute("/review/flow/close")({
  loader: async () => ({ close: await getCloseSnapshot({ data: { limit: 20 } }).catch(() => null) }),
  component: FlowClosePage,
});

function FlowClosePage() {
  const { close } = Route.useLoaderData();
  return (
    <Frame wide aside="资金流向 · 收盘快照">
      <FlowSectionTabs />
      <CloseSnapshotPanel close={close} />
    </Frame>
  );
}
