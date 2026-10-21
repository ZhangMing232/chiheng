/**
 * 这个文件是干什么的：
 * 命令行跑一轮 AI 全局诊断（和将来 /ai 页的「agent 诊断」按钮同一条路径：
 * runAgentDiagnosis）。只诊断不行动——输出一份人读的分析报告，落在
 * data/agent-diagnosis.json，并记进 ai-log（layer=agent）。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/agent-diagnose.ts
 */

import { runAgentDiagnosis } from "@/lib/market/agent-loop";

const { ok, diagnosis, error } = await runAgentDiagnosis("manual");

if (!ok || !diagnosis) {
  console.error(`诊断失败：${error ?? "未知"}`);
  process.exit(1);
}

console.log([
  `【总评】${diagnosis.summary}`,
  "",
  `【因子层】${diagnosis.factorLayer}`,
  "",
  `【策略层】${diagnosis.strategyLayer}`,
  "",
  ...(diagnosis.suggestions.length > 0
    ? ["【建议动作】", ...diagnosis.suggestions.map((s) => `· ${s}`), ""]
    : []),
  ...(diagnosis.ruleChangeRequests.length > 0
    ? ["【规则变更请求（需主人拍板）】", ...diagnosis.ruleChangeRequests.map((s) => `· ${s}`)]
    : []),
].join("\n"));
