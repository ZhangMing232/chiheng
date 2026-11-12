/**
 * 这个文件是干什么的：
 * 「因子」区的「资金流探路」子页（/factors/flow）。量价之外换了个维度再试：
 * 东财个股日级主力净流入，按窗口分组的检验结果。
 *
 * 你需要知道的：
 * - 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab）。
 * - 窗口只有 120 个交易日，G3 两段各 60 天偏短——这里的 t 只当方向，不当过关。
 */

import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, FACTOR_TABS } from "@/components/section-tabs";
import { StateBlock } from "@/components/state-block";
import { getFactorDiag } from "@/lib/market/quotes.functions";
import { flowStress } from "@/lib/market/factors-view";
import { FlowProbePanel } from "@/components/screener/factor-diag-panels";
import type { FactorDiagPayload } from "@/lib/market/factor-runs-file";
import { FactorSectionTabs, messageOf, Section } from "@/components/factor-sections";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/factors/flow")({
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
  component: FactorFlowPage,
});

function FactorFlowPage() {
  const { diag } = Route.useLoaderData();
  const flowGroups = useMemo(() => flowStress(diag.flowProbe), [diag.flowProbe]);
  return (
    <Frame wide aside="因子发掘 · 资金流探路">
      <SectionTabs ariaLabel="因子实验室" tabs={FACTOR_TABS} />
      <PixelHeader label="FACTORS // EXPLORE" meta="外部因子探路 · 借鉴来的能不能用" />
      <FactorSectionTabs />
      <Section
        title="资金流探路"
        hint="量价之外换了个维度再试：东财个股日级主力净流入。窗口只有 120 个交易日，G3 两段各 60 天偏短——这里的 t 只当方向，不当过关。"
      >
        {flowGroups.length > 0 ? (
          <FlowProbePanel groups={flowGroups} />
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock
              kind="empty"
              title="资金流探路还没跑"
              hint="这份分析要用到资金流缓存，以及 5 / 10 / 20 日窗口的回测结果，目前都还没生成。数据准备好后，这里会自动出现对比图。"
            />
          </div>
        )}
      </Section>
    </Frame>
  );
}
