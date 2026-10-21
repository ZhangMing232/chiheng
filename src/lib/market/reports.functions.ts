/**
 * 这个文件是干什么的：
 * 「我的报告」的服务端接口：存一份研判报告、列出存过的、读某一份的内容。
 * 报告是**私人研判存档**，每个请求都先解析身份，只读本/写本人的目录。
 *
 * 你需要知道的：
 * - 报告落在 `data/reports/<userId>/`，**data 不在 git 里**，换机器必然读不到。
 *   页面照实说「这台机器上还没有报告」，不假装有。
 * - 存报告要连带 AI 综合一起存，否则事后分不清哪句是 AI 说的。
 */

import { createServerFn } from "@tanstack/react-start";
import { listReports, readReport, saveReport, type ReportIndexRow } from "./report-store.ts";
import type { ResearchReport } from "./research.ts";
import type { AiSynthesis } from "./research-ai.ts";

/** 这次请求是谁。没有身份就抛 401，不碰任何人的报告目录。 */
async function whoAmI(): Promise<string> {
  const { requireUserId } = await import("@/lib/auth/verify.server");
  return requireUserId();
}

/** 列出本人存过的报告，新的在前。 */
export const getReports = createServerFn({ method: "GET" }).handler(async (): Promise<ReportIndexRow[]> => {
  return listReports(await whoAmI());
});

/** 存一份。report 和 ai 都由页面传上来（那里刚跑完七阶段和 AI 综合）。 */
export const saveResearchReport = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { report?: ResearchReport; ai?: AiSynthesis | null };
    if (!d?.report || !Array.isArray(d.report.stages)) throw new Error("报告结构不对：没有 stages");
    return { report: d.report, ai: d.ai ?? null };
  })
  .handler(async ({ data }) => {
    const saved = await saveReport(data.report, data.ai, await whoAmI());
    return { id: saved.id, path: saved.path };
  });

/** 读本人某一份的 markdown 原文。找不到返回 null，页面说「没有这一份」。 */
export const getReportContent = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const id = typeof (data as { id?: unknown })?.id === "string" ? (data as { id: string }).id : "";
    if (!id) throw new Error("要给出报告 id");
    return { id: id.slice(0, 60) };
  })
  .handler(async ({ data }) => {
    const md = await readReport(data.id, await whoAmI());
    return { id: data.id, md };
  });
