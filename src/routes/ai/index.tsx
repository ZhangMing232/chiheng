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
import { getAILog, getAIStatus, runEvolve, saveAIPrefs } from "@/lib/market/quotes.functions";
import type { AILogEntry } from "@/lib/market/ai-log";
import {
  AISectionTabs,
  Section,
  type AIStatusPayload,
} from "@/components/ai-panels";

export const Route = createFileRoute("/ai/")({
  loader: async () => {
    const [ai, logRes] = await Promise.all([
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [] })),
      getAILog().catch((): { allowed: boolean; entries: AILogEntry[] } => ({ allowed: false, entries: [] })),
    ]);
    return { ai, log: logRes.entries };
  },
  component: AIConsolePage,
});

function AIConsolePage() {
  const { ai, log } = Route.useLoaderData();
  const router = useRouter();
  const [evolveMsg, setEvolveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evolve" | null>(null);

  /** 一键完整进化：因子层 → 策略层，两层各自记账，结果拼一句汇报。 */
  const runEvolveOnce = async () => {
    setBusy("evolve");
    setEvolveMsg(null);
    try {
      const res = await runEvolve();
      const part = (label: string, r: { ok: boolean; proposed: number; error?: string }): string =>
        `${label} ${r.ok ? `进 ${r.proposed} 个` : `没跑成（${r.error ?? "?"}）`}`;
      setEvolveMsg(`${part("因子层", res.factor)} · ${part("策略层", res.strategy)}。下一轮 prompt 会读到这两轮的下场，据此自我纠错。`);
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  /** 自动进化开关：收盘后记账进程每天自动跑一轮（ai-log 去重，每天最多一轮）。 */
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
        hint="自我迭代的闭环：AI 每轮提议都进账本，下一轮 prompt 会读到这些提议的下场（过没过 6 关、转正还是淘汰），据此纠错。开自动进化后，收盘后每天自己跑一轮。AI 能做什么、不能碰什么，全文见 AI-BOUNDARY.md。"
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
                      {e.layer === "factor" ? "因子" : "策略"}
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

      <p className="px-1 text-[11px] leading-relaxed text-warn">
        AI 提议 ≠ 生效：因子要过 6 关，挑战者要过 30 笔 Welch 判决；两个判决函数都预先登记在代码里，AI 无权修改。
      </p>
    </Frame>
  );
}
