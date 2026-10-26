/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「进化控制台」子页（/ai）。自我迭代的闭环控制：手动跑一轮
 * 完整进化（因子层 → 策略层）、自动进化开关、以及每轮提议/被拒的运行账本。
 *
 * 你需要知道的：
 * - 2026-10-21 由 AI 管理整页拆出（原来是本地状态的 PageTabs）。
 * - AI 每轮提议都进账本，下一轮 prompt 会读到这些提议的下场（过没过 6 关、
 *   转正还是淘汰），据此纠错。AI 能做什么、不能碰什么，全文见 AI-BOUNDARY.md。
 * - 因子待验队列 / 挑战者提名在因子页的 AI 闭环面板里，不在这里。
 */

import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getAILog, getAIStatus, getAgentDiagnosis, getVTToolsStatus, runAgentDiagnose, runEvolve, saveAIPrefs } from "@/lib/market/quotes.functions";
import type { AILogEntry } from "@/lib/market/ai-log";
import {
  AISectionTabs,
  Section,
  type AIStatusPayload,
} from "@/components/ai-panels";

export const Route = createFileRoute("/ai/")({
  loader: async () => {
    const [ai, logRes, diagnosis, vtRes] = await Promise.all([
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [], fallbackOrder: [] })),
      getAILog().catch((): { allowed: boolean; entries: AILogEntry[] } => ({ allowed: false, entries: [] })),
      getAgentDiagnosis().catch(() => null),
      getVTToolsStatus().catch(() => ({ allowed: false as const })),
    ]);
    return { ai, log: logRes.entries, diagnosis, vt: vtRes.allowed ? vtRes.status : null };
  },
  component: AIConsolePage,
});

function AIConsolePage() {
  const { ai, log, diagnosis, vt } = Route.useLoaderData();
  const router = useRouter();
  const [evolveMsg, setEvolveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evolve" | "diagnose" | null>(null);

  /** AI 全局诊断：读整个账本出报告（只诊断不行动，规则变更只请求人拍板）。 */
  const runDiagnose = async () => {
    setBusy("diagnose");
    setEvolveMsg(null);
    try {
      const res = await runAgentDiagnose();
      setEvolveMsg(res.ok ? `诊断完成：${res.diagnosis?.summary ?? ""}` : `诊断失败（${res.error ?? "?"}）`);
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  /** 一键完整进化：全局诊断（观察）→ 因子层 → 策略层，各层各自记账，结果拼一句汇报。 */
  const runEvolveOnce = async () => {
    setBusy("evolve");
    setEvolveMsg(null);
    try {
      const res = await runEvolve();
      const part = (label: string, r: { ok: boolean; proposed: number; error?: string }): string =>
        `${label} ${r.ok ? `进 ${r.proposed} 个` : `没跑成（${r.error ?? "?"}）`}`;
      const diag = res.agent ? (res.agent.ok ? `诊断 ok（${res.agent.diagnosis?.summary ?? ""}）` : `诊断没跑成（${res.agent.error ?? "?"}）`) : "诊断缺席";
      setEvolveMsg(`${diag} · ${part("因子层", res.factor)} · ${part("策略层", res.strategy)}。诊断的建议本轮就进了两层 prompt；两层的下场下一轮自己读账纠错。`);
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  /** 自动进化开关：收盘后记账进程每天自动跑一轮；失败的层当天自动补跑（上限 3 次、间隔 30 分钟），成功的层不再重复跑。 */
  const toggleAuto = async (next: boolean) => {
    try {
      await saveAIPrefs({ data: { autoEvolve: next } });
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "保存开关失败");
    }
  };

  return (
    <Frame aside="AI 管理 · 进化控制台">
      <AISectionTabs />
      <Section
        id="ai-console"
        title="进化控制台"
        hint="自我迭代的闭环：先全局诊断（观察），再因子层、策略层提议（行动）——诊断的建议当天就进两层 prompt。每轮提议都进账本，下一轮读到这些提议的下场（过没过 6 关、转正还是淘汰），据此纠错。开自动进化后，收盘后每天自己跑一轮（诊断先行）。AI 能做什么、不能碰什么，全文见 AI-BOUNDARY.md。"
      >
        <div className="border-b border-line px-3.5 py-2">
          {ai.allowed ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                disabled={busy !== null || !ai.configured}
                onClick={() => void runEvolveOnce()}
                className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "evolve" ? "AI 进化中…" : "跑一轮完整进化"}
              </button>
              <button
                type="button"
                disabled={busy !== null || !ai.configured}
                onClick={() => void runDiagnose()}
                className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "diagnose" ? "AI 诊断中…" : "跑一轮全局诊断"}
              </button>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={ai.autoEvolve}
                  onChange={(e) => void toggleAuto(e.target.checked)}
                  className="accent-brand"
                />
                收盘后每天自动进化一轮
              </label>
              {evolveMsg ? <span className="min-w-0 basis-full text-xs text-muted">{evolveMsg}</span> : null}
            </div>
          ) : (
            <p className="text-xs text-muted">主人账号登录后可运行进化和开关自动模式。</p>
          )}
        </div>
        <div className="px-3.5 py-3">
          {log.length > 0 ? (
            <Table className="data-table" caption="AI 运行账本：每轮提议、被拒原因都记着，下一轮 prompt 会读到">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>时间</th>
                  <th className={thClass()}>层</th>
                  <th className={thClass()}>触发</th>
                  <th className={thClass()}>结果</th>
                  <th className={thClass("text-left")}>提议</th>
                  <th className={thClass("text-left")}>被拒 / 报错</th>
                  <th className={thClass("text-left")}>备注</th>
                </tr>
              </thead>
              <tbody>
                {[...log].reverse().slice(0, 20).map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="px-2.5 py-1.5 whitespace-nowrap text-[11px] text-muted">
                      {e.at.slice(0, 16).replace("T", " ")}
                    </td>
                    <td data-l="层" className="px-2.5 py-1.5 text-[11px]">
                      {e.layer === "factor" ? "因子" : e.layer === "agent" ? "诊断" : "策略"}
                    </td>
                    <td data-l="触发" className="px-2.5 py-1.5 text-[11px] text-muted">
                      {e.trigger === "auto" ? "自动" : "手动"}
                    </td>
                    <td data-l="结果" className={`px-2.5 py-1.5 text-[11px] ${e.ok ? "text-up" : "text-down"}`}>
                      {e.ok ? `进 ${e.proposed.length}` : "失败"}
                    </td>
                    <td data-l="提议" className="max-w-[28ch] px-2.5 py-1.5 text-[11px] text-muted">
                      {e.proposed.length > 0 ? e.proposed.map((p) => p.name).join("、") : "—"}
                    </td>
                    <td data-l="被拒" className="max-w-[32ch] px-2.5 py-1.5 text-[11px] text-muted">
                      {e.error ?? (e.rejected.length > 0 ? e.rejected.slice(0, 2).join("；") : "—")}
                    </td>
                    {e.note ? (
                      <td data-l="备注" className="max-w-[36ch] truncate px-2.5 py-1.5 text-[11px] text-warn" title={e.note}>
                        {e.note}
                      </td>
                    ) : (
                      <td data-l="备注" className="px-2.5 py-1.5 text-[11px] text-muted">—</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <StateBlock kind="empty" title="还没有运行记录" hint="点上面的「跑一轮完整进化」，或开自动进化让记账进程收盘后自己跑。" />
          )}
        </div>
      </Section>

      <Section
        id="ai-diagnosis"
        title="全局诊断报告"
        hint="AI 大脑的「观察」层：把因子判决史、队列、死因档案、挑战者、策略闸整个账本摊给它，出一份诊断。只诊断不行动——建议要走提议通道，规则变更只生成请求给人拍板。"
      >
        <div className="px-3.5 py-3">
          {diagnosis ? (
            <div className="space-y-2.5 text-xs leading-relaxed">
              <p className="text-[11px] text-muted">诊断时间：{diagnosis.at.slice(0, 16).replace("T", " ")}</p>
              <div>
                <p className="mb-0.5 font-medium text-up">总评</p>
                <p>{diagnosis.summary || "—"}</p>
              </div>
              <div>
                <p className="mb-0.5 font-medium">因子层</p>
                <p className="text-muted">{diagnosis.factorLayer || "—"}</p>
              </div>
              <div>
                <p className="mb-0.5 font-medium">策略层</p>
                <p className="text-muted">{diagnosis.strategyLayer || "—"}</p>
              </div>
              {diagnosis.suggestions.length > 0 ? (
                <div>
                  <p className="mb-0.5 font-medium">建议动作</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-muted">
                    {diagnosis.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {diagnosis.ruleChangeRequests.length > 0 ? (
                <div>
                  <p className="mb-0.5 font-medium text-warn">规则变更请求（需主人拍板，AI 无权直接改）</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-warn">
                    {diagnosis.ruleChangeRequests.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {diagnosis.numberCheck ? (
                diagnosis.numberCheck.ungrounded.length > 0 ? (
                  <div className="rounded border border-warn bg-warn-soft px-2.5 py-2">
                    <p className="mb-0.5 font-medium text-warn">
                      数字核验：{diagnosis.numberCheck.ungrounded.length} 个数在本轮账本快照里找不到出处
                    </p>
                    <p className="text-muted">
                      以下数字是模型自己说的，账本里没有——引用它们下结论前先核实：
                      {diagnosis.numberCheck.ungrounded.join("、")}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted">数字核验通过：报告引用的数字全部能在本轮账本快照里找到出处。</p>
                )
              ) : null}
            </div>
          ) : (
            <StateBlock kind="empty" title="还没有诊断报告" hint="点上面的「跑一轮全局诊断」；开自动进化后，收盘后每轮自动进化都是诊断先行，报告落在这里。" />
          )}
        </div>
      </Section>

      <Section
        id="vt-tools"
        title="VT 工具矿山"
        hint="Vibe-Trading 的 MCP server（stdio 子进程随用随起）：74 个只读研究工具——A 股资金流 / 全市场筛选 / 研报检索 / 回测分析。shell 工具对方默认就不注册。下一步接进诊断/提议的 prompt 当证据源。"
      >
        <div className="px-3.5 py-3">
          {vt ? (
            vt.online ? (
              <div>
                <p className="mb-2 text-xs">
                  <span className="text-up">● 在线</span>
                  <span className="ml-2 text-muted">{vt.toolCount} 个工具 · 检测于 {vt.checkedAt.slice(11, 19)}</span>
                </p>
                <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                  {vt.tools.slice(0, 24).map((t) => (
                    <p key={t.name} className="truncate text-[11px] text-muted" title={t.description}>
                      <span className="font-mono text-foreground">{t.name}</span>
                      {t.description ? ` — ${t.description.slice(0, 40)}` : ""}
                    </p>
                  ))}
                </div>
                {vt.toolCount > 24 ? <p className="mt-1 text-[11px] text-muted">… 共 {vt.toolCount} 个，其余略</p> : null}
              </div>
            ) : (
              <StateBlock kind="empty" title="VT 工具离线" hint={`${vt.error ?? "未知原因"}。venv 路径可用 CHIHENG_VT_MCP_HOME 环境变量改。`} />
            )
          ) : (
            <StateBlock kind="empty" title="工具状态未知" hint="主人账号登录后自动检测。" />
          )}
        </div>
      </Section>

      <p className="px-1 text-[11px] leading-relaxed text-warn">
        AI 提议 ≠ 生效：因子要过 6 关，挑战者要过 30 笔 Welch 判决；两个判决函数都预先登记在代码里，AI 无权修改。
      </p>
    </Frame>
  );
}
