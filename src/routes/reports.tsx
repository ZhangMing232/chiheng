/**
 * 这个文件是干什么的：
 * 「我的报告」页。列出这台机器上存过的研判报告，点开能看原文。
 *
 * 你需要知道的：
 * - 报告在 `data/reports/`，**data 不在 git 里**。换机器、或者从来没存过，
 *   这一页就是空的——空态要说清「去哪存」（/research 页研判完点「存成报告」）。
 * - 每一行都带 AI 状态：ok = 有 AI 综合；failed/skipped = 只有规则结论。
 *   不许让读者以为每份都有 AI 参与。
 */

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getReportContent, getReports } from "@/lib/market/reports.functions";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/reports")({
  loader: () => getReports(),
  component: ReportsPage,
});

const AI_LABEL: Record<string, { text: string; tone: "brand" | "warn" | "muted" }> = {
  ok: { text: "有 AI 综合", tone: "brand" },
  refused: { text: "AI 被红线拦下", tone: "warn" },
  failed: { text: "AI 没接通", tone: "warn" },
  skipped: { text: "未调用 AI", tone: "muted" },
  none: { text: "未调用 AI", tone: "muted" },
};

function ReportsPage() {
  const rows = Route.useLoaderData();
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: opened, isFetching } = useQuery({
    queryKey: ["report-content", openId],
    queryFn: () => getReportContent({ data: { id: openId! } }),
    enabled: openId != null,
    staleTime: 60_000,
  });

  return (
    <Frame>
      <Panel title="我的报告" note={<span className="text-xs text-muted">每次研判可存一份 · 存在本机 data/reports/</span>}>
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title="这台机器上还没有报告"
            hint="去「个股研判」页输入一只股票，七阶段跑完后点「存成报告」，这里就会出现。报告存在本机，data 目录不进 git，换机器不会跟过来。"
            action={{ label: "去个股研判", onClick: () => { window.location.assign("/research"); } }}
          />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">已保存的研判报告列表</caption>
            <thead>
              <tr>
                <th className={thClass("text-left")}>标的</th>
                <th className={thClass("text-left")}>生成时间</th>
                <th className={thClass("text-left")}>AI</th>
                <th className={thClass("text-right")}>缺口</th>
                <th className={thClass("text-right")}>拦下</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className={tdClass("text-left")}>
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      className="text-accent hover:underline"
                    >
                      {row.name || row.symbol}
                      <span className="ml-2 text-xs text-muted">{row.symbol}</span>
                    </button>
                  </td>
                  <td className={tdClass("text-left text-xs text-muted")}>{row.at.replace("T", " ").slice(0, 19)}</td>
                  <td className={tdClass("text-left")}>
                    <Tag tone={AI_LABEL[row.aiStatus]?.tone ?? "muted"}>{AI_LABEL[row.aiStatus]?.text ?? row.aiStatus}</Tag>
                  </td>
                  <td className={tdClass("text-muted")}>{row.gaps}</td>
                  <td className={tdClass(row.blocked > 0 ? "text-warn" : "text-muted")}>{row.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {openId ? (
        <Panel title="报告原文" note={<span className="text-xs text-muted">markdown · 与落盘文件一致</span>}>
          {isFetching && !opened ? (
            <div className="px-3 py-6 text-center text-sm text-muted">正在读…</div>
          ) : opened?.md ? (
            <pre className="max-h-[32rem] overflow-auto scroll-slim px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">{opened.md}</pre>
          ) : (
            <StateBlock kind="error" title="这份报告读不到" hint="文件可能被手动删了，或者这台机器不是当初存它的那台（data 目录不进 git）。" />
          )}
        </Panel>
      ) : null}

      <p className="px-1 text-xs leading-relaxed text-muted">
        报告里带了宪法口径、四档可信度和证据 id——AI 说过什么、依据是哪几条，事后都查得到。
        想去研判新标的？<Link to="/research" search={{ q: "" }} className="text-accent hover:underline">去个股研判</Link>
      </p>
    </Frame>
  );
}
