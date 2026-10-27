/**
 * 这个文件是干什么的：
 * 「因子」区的「缩量归因」子页（/factors/attrib）。缩量天数是 |t| 最大、
 * 最有希望的一个因子，但 G3 两段翻号没过关——这一块解释「为什么没过关」。
 *
 * 你需要知道的：
 * - 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab）。
 * - 归因解释本身不是过关证明，hint 里写明了这个边界。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { getFactorDiag } from "@/lib/market/quotes.functions";
import { ShrinkFlipPanel } from "@/components/screener/factor-diag-panels";
import type { FactorDiagPayload } from "@/lib/market/factor-runs-file";
import { FactorSectionTabs, messageOf, Section } from "@/components/factor-sections";

export const Route = createFileRoute("/factors/attrib")({
  loader: async () => {
    const diag = await getFactorDiag().catch(
      (e: unknown): FactorDiagPayload => ({
        shrinkFlip: null,
        shrinkBull: null,
        flowProbe: [],
        badLines: 0,
        missing: messageOf(e),
      }),
    );
    return { diag };
  },
  component: FactorAttribPage,
});

function FactorAttribPage() {
  const { diag } = Route.useLoaderData();
  return (
    <Frame wide aside="因子发掘 · 缩量归因">
      <FactorSectionTabs />
      <Section
        title="缩量天数归因"
        hint="缩量天数是 |t| 最大、最有希望的一个，但 G3 两段翻号没过关。这一块是「为什么没过关」的解释，它本身不是过关证明。"
      >
        {diag.shrinkFlip ? (
          <ShrinkFlipPanel diag={diag.shrinkFlip} bull={diag.shrinkBull} />
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock
              kind="empty"
              title="归因诊断还没跑"
              hint={
                "在本机跑：BT_FACTOR=1 BT_N=10 BT_DIAG=shrinkDays BT_NO_LOG=1 node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts" +
                "（BT_NO_LOG=1 必须带，否则会往因子日志里多塞一批）"
              }
            />
          </div>
        )}
      </Section>
    </Frame>
  );
}
