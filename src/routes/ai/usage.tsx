/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「Token 用量」子页（/ai/usage）。每次调 AI 自动记账：
 * 输入/输出/总 tokens、耗时、成败、哪条链路（因子/策略/测试）烧的，
 * 外加按现价估算的费用。
 *
 * 你需要知道的：
 * - 2026-10-21 由 AI 管理整页拆出（原来是本地状态的 PageTabs）。
 * - 接口不返回 usage 就记 0，不瞎编；历史账永不改口径，估算按现行参考价另算。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { getAIUsage } from "@/lib/market/quotes.functions";
import { AISectionTabs, Section, UsageSection, type UsagePayload } from "@/components/ai-panels";

export const Route = createFileRoute("/ai/usage")({
  loader: async () => {
    const usage = await getAIUsage().catch((): UsagePayload => ({ allowed: false, entries: [], stats: null }));
    return { usage };
  },
  component: AIUsagePage,
});

function AIUsagePage() {
  const { usage } = Route.useLoaderData();
  return (
    <Frame wide aside="AI 管理 · Token 用量">
      <AISectionTabs />
      <Section
        id="ai-usage"
        title="Token 用量监控"
        hint="每次调 AI 自动记账：输入/输出/总 tokens、耗时、成败、哪条链路（因子/策略/测试）烧的。接口不返回 usage 就记 0，不瞎编。"
      >
        <UsageSection usage={usage} />
      </Section>
    </Frame>
  );
}
