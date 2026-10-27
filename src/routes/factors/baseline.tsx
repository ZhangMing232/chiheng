/**
 * 这个文件是干什么的：
 * 「因子」区的「基线原文」子页（/factors/baseline）。回测基线整段原文，
 * 一字未加工。
 *
 * 你需要知道的：
 * - 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab）。
 * - 它是人工维护的结论记录，时间可能和最新批次对不上——以判决子页的数字为准。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { getFactorBaseline } from "@/lib/market/quotes.functions";
import type { FactorBaselinePayload } from "@/lib/market/factor-runs-file";
import { FactorSectionTabs, messageOf, Section } from "@/components/factor-sections";

export const Route = createFileRoute("/factors/baseline")({
  loader: async () => {
    const baseline = await getFactorBaseline().catch(
      (e: unknown): FactorBaselinePayload => ({ name: null, text: null, bytes: 0, missing: messageOf(e) }),
    );
    return { baseline };
  },
  component: FactorBaselinePage,
});

function FactorBaselinePage() {
  const { baseline } = Route.useLoaderData();
  return (
    <Frame wide aside="因子发掘 · 基线原文">
      <FactorSectionTabs />
      <Section
        title="回测基线原文"
        hint="整段原文，一字未加工。它是人工维护的结论记录，时间可能和上面最新批次对不上——以判决子页的数字为准。"
      >
        {baseline.text ? (
          <details className="px-3.5 py-3">
            <summary className="cursor-pointer text-xs text-muted">
              {baseline.name}（{(baseline.bytes / 1024).toFixed(1)} KB，默认收起）
            </summary>
            <pre className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {baseline.text}
            </pre>
          </details>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有基线文本" hint={baseline.missing ?? "跑一次回测后会写 baseline-*.txt"} />
          </div>
        )}
      </Section>
    </Frame>
  );
}
