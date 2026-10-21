/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「闸门与判据」子页（/ai/rules）。五组预登记阈值
 * （数据审计/熔断/衰减/挑战者/策略闸门）的当前值，只读。
 *
 * 你需要知道的：
 * - 2026-10-21 由 AI 管理整页拆出（原来是本地状态的 PageTabs）。
 * - 数值运行时才从常量拼（system-rules.ts），页面不写字面量——防止面板数字
 *   和代码常量脱钩。改阈值要到对应文件改常量提交（改规则要带理由）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { getSystemRules } from "@/lib/market/quotes.functions";
import { AISectionTabs, RulesSection } from "@/components/ai-panels";

export const Route = createFileRoute("/ai/rules")({
  loader: async () => {
    const rules = await getSystemRules().catch(() => null);
    return { rules };
  },
  component: AIRulesPage,
});

function AIRulesPage() {
  const { rules } = Route.useLoaderData();
  return (
    <Frame aside="AI 管理 · 闸门与判据">
      <AISectionTabs />
      {rules ? <RulesSection groups={rules.groups} /> : <StateBlock kind="empty" title="闸门规则没读到" />}
    </Frame>
  );
}
