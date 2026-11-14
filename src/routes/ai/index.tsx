/**
 * 这个文件是干什么的：
 * 「概览」页（/ai）—— 小机的工作驾驶舱。AI 板块重整后的总部首页：
 * 总开关、状态灯、例行动作（原进化流水线/诊断/规则审批收编）、统一时间线、工单。
 *
 * 你需要知道的：
 * - 2026-11-14 重整：AI = 小机一个员工。旧「AI 控制中枢」的区块全部收编：
 *   进化流水线/运行账本 → 例行动作 + 统一时间线；诊断报告 → 例行动作内；
 *   规则变更审批 → 例行动作内（它是例行的产物）。
 *   删掉的两个重复入口：跑一轮进化/诊断按钮（派活框取代）、自动进化独立开关
 *   （收编为例行区块内的子开关）。
 * - 两本账（ai-log 例行 + agent-jobs 派活）经 timeline.ts 合成一条时间线；
 *   原始文件不动——例行账仍是例行 prompt 的自我记忆。
 * - 总开关 off = 例行/派活/定时/工单执行/对话全停（record-journal 与
 *   agent-runner / agent-scheduler / askButler 四处读同一个开关文件）。
 */

import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { CollapsibleSection } from "@/components/collapsible";
import { GlowPanel, HealthRing, MiniBars, Pipeline, type PipelineStage } from "@/components/ai-kit";
import { AISectionTabs, Section, type AIStatusPayload } from "@/components/ai-panels";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";
import {
  applyRuleChange,
  rejectRuleChange,
  getAgentJobs,
  getAgentSchedules,
  getAIStatus,
  getAIUsage,
  getAgentDiagnosis,
  getAILog,
  getChallengers,
  getIndices,
  getPendingRuleChanges,
  getRecorder,
  getRuleChangeEffects,
  setAgentMasterSwitch,
  saveAIPrefs,
} from "@/lib/market/quotes.functions";
import { buildTimeline, type TimelineItem } from "@/lib/market/timeline";
import type { AILogEntry } from "@/lib/market/ai-log";
import type { AIUsageEntry } from "@/lib/market/ai-usage";
import type { AgentJob } from "@/lib/market/agent-jobs";
import type { AgentProposal } from "@/lib/market/agent-schedules";
import { CheckCircle2, CircleDashed } from "lucide-react";

const DAY = 86_400_000;

export const Route = createFileRoute("/ai/")({
  loader: async () => {
    const [ai, logRes, usageRes, jobsRes, schedRes, diagnosis, rulesRes, effectsRes, chalRes, recorder, indices] = await Promise.all([
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [], fallbackOrder: [] })),
      getAILog().catch((): { allowed: boolean; entries: AILogEntry[] } => ({ allowed: false, entries: [] })),
      getAIUsage().catch((): { allowed: false; entries: AIUsageEntry[]; stats: null } => ({ allowed: false, entries: [], stats: null })),
      getAgentJobs().catch(() => ({ allowed: false as const, master: { enabled: true, at: "" }, jobs: [] as AgentJob[], budget: null })),
      getAgentSchedules().catch(() => ({ allowed: false as const, schedules: [], proposals: [] as AgentProposal[] })),
      getAgentDiagnosis().catch(() => null),
      getPendingRuleChanges().catch(() => ({ pending: [], log: [] })),
      getRuleChangeEffects().catch(() => ({ effects: [] as never[], why: "读不到" })),
      getChallengers().catch(() => ({ list: [] as { id: string; status: string }[], champions: {}, rule: null })),
      getRecorder().catch(() => ({ at: null as number | null, ok: true })),
      getIndices().catch(() => []),
    ]);
    return {
      ai,
      log: logRes.entries,
      usage: usageRes,
      master: jobsRes.master,
      jobs: jobsRes.jobs,
      budget: jobsRes.budget,
      schedules: schedRes.schedules,
      proposals: schedRes.proposals,
      diagnosis,
      rules: rulesRes,
      effects: effectsRes.effects,
      chal: chalRes.list,
      chalRule: chalRes.rule,
      recorder,
      indexCount: indices.length,
      serverNow: Date.now(),
    };
  },
  component: AIOverviewPage,
});

function AIOverviewPage() {
  const d = Route.useLoaderData();
  const router = useRouter();
  const [masterBusy, setMasterBusy] = useState(false);
  const [ruleBusy, setRuleBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const masterOn = d.master?.enabled ?? true;

  const toggleMaster = async (next: boolean) => {
    setMasterBusy(true);
    setMsg(null);
    try {
      await setAgentMasterSwitch({ data: { enabled: next } });
      await router.invalidate();
    } finally {
      setMasterBusy(false);
    }
  };

  /** 例行子开关（原「自动进化」）：只在总开关开着时有效。 */
  const toggleRoutine = async (next: boolean) => {
    setMsg(null);
    try {
      await saveAIPrefs({ data: { autoEvolve: next } });
      await router.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "保存失败");
    }
  };

  /** 批准/驳回一条例行产物（核心规则变更）。 */
  const decideRule = async (id: string, action: "apply" | "reject") => {
    setRuleBusy(id);
    setMsg(null);
    try {
      const res = action === "apply"
        ? await applyRuleChange({ data: { id } })
        : await rejectRuleChange({ data: { id } });
      setMsg(res.ok ? (action === "apply" ? "已批准，写入规则文件" : "已驳回") : (("error" in res && res.error) || "操作失败"));
      await router.invalidate();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "操作失败");
    } finally {
      setRuleBusy(null);
    }
  };

  // ── 真实计数 ──
  const todayIso = new Date(d.serverNow).toISOString().slice(0, 10);
  const timeline = buildTimeline(d.log, d.jobs, d.usage.entries ?? [], 40);
  const spentToday = timeline.filter((t) => t.at.slice(0, 10) === todayIso && t.status !== "running").reduce((a, t) => a + (t.costCny ?? 0), 0);
  const running = d.chal.filter((c) => c.status === "running").length;
  const judged = d.chal.filter((c) => c.status !== "running").length;
  const pendingRules = d.rules.pending.filter((p) => p.status === "pending").length;
  const pendingProposals = d.proposals.filter((p) => p.status === "pending").length;
  const todayRoutine = d.log.filter((e) => e.at.slice(0, 10) === todayIso && e.trigger === "auto");
  const routineStages: PipelineStage[] = [
    { icon: <CircleDashed size={16} />, step: "01", title: "诊断", desc: "读全部账本", metric: todayRoutine.some((e) => e.layer === "agent") ? "今日已跑" : "待今日 15:03", done: todayRoutine.some((e) => e.layer === "agent") },
    { icon: <CircleDashed size={16} />, step: "02", title: "因子层", desc: "提议新候选", metric: `${todayRoutine.filter((e) => e.layer === "factor").reduce((a, e) => a + e.proposed.length, 0)} 进`, done: todayRoutine.some((e) => e.layer === "factor") },
    { icon: <CircleDashed size={16} />, step: "03", title: "策略层", desc: "提名挑战者", metric: "每日例行动作", done: todayRoutine.some((e) => e.layer === "strategy") },
    { icon: <CircleDashed size={16} />, step: "04", title: "基因组层", desc: "产策略 spec", metric: "每日例行动作", done: todayRoutine.some((e) => e.layer === "genome") },
  ];
  const checks = [
    { label: "在岗", ok: masterOn, detail: masterOn ? "总开关开着" : "总开关关闭——全部口子停" },
    { label: "例行", ok: d.ai.autoEvolve, detail: d.ai.autoEvolve ? "交易日 15:03 自动跑" : "例行已关（子开关）" },
    { label: "记账", ok: d.recorder.at != null && d.serverNow - d.recorder.at < 5 * 60_000, detail: d.recorder.at ? `${Math.round((d.serverNow - d.recorder.at) / 60_000)} 分钟前` : "还没跑" },
    { label: "行情", ok: d.indexCount > 0, detail: d.indexCount > 0 ? `拿得到 ${d.indexCount} 个指数` : "还没拉到" },
    { label: "判决", ok: d.chal.length > 0, detail: d.chal.length > 0 ? `挑战者 ${d.chal.length} 个` : "无档案" },
  ];
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  const sourceLabel = (s: TimelineItem["source"]): string => (s === "routine" ? "例行" : s === "manual" ? "手动" : "定时");
  const sourceTone = (s: TimelineItem["source"]): "brand" | "muted" | "warn" => (s === "routine" ? "muted" : s === "manual" ? "brand" : "warn");

  return (
    <Frame wide aside="AI · 小机" decorHeader={false}>
      <PixelHeader label="AGENT // HQ" meta="AI = 小机一个员工 · 例行 + 派活 + 对话，一本账" />
      <AISectionTabs />

      {/* 总开关：唯一开关 */}
      <div
        className={
          "mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded border px-4 py-3 " +
          (masterOn ? "border-ai-line bg-ai-soft" : "border-warn/50 bg-warn-soft")
        }
      >
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg">
          <input type="checkbox" checked={masterOn} disabled={masterBusy} onChange={(e) => void toggleMaster(e.target.checked)} className="size-4 accent-brand" />
          小机在岗
        </label>
        <span className="min-w-0 flex-1 text-[12px] text-muted">
          {masterOn
            ? "总开关开着：例行（交易日 15:03）、派活、定时任务、对话都可用。要单独停例行，用下面「例行动作」里的子开关。"
            : "总开关关了：例行 / 派活 / 定时 / 工单执行 / 对话全部停。清单、预算、账本原样保留，重开照旧。"}
        </span>
        {msg ? <span className="basis-full text-xs text-muted">{msg}</span> : null}
      </div>

      {/* 健康总览 */}
      <GlowPanel className="mt-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4">
          <HealthRing value={score} hint={`五个真实检查项：${checks.map((c) => `${c.label} ${c.ok ? "✓" : "✗"}`).join(" · ")}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-medium text-fg">{masterOn ? "小机在岗" : "小机下岗"}</p>
              <Tag tone={masterOn ? "up" : "warn"}>{checks.filter((c) => c.ok).length}/5 检查项通过</Tag>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {checks.map((c) => (
                <span key={c.label} title={c.detail} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] ${c.ok ? "border-ai-line text-ai" : "border-warn/50 text-warn"}`}>
                  {c.ok ? <CheckCircle2 size={11} /> : <CircleDashed size={11} />}
                  {c.label}
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-xs text-muted">今日已花</div>
              <div className="text-2xl font-semibold tabular-nums text-ai">¥{spentToday.toFixed(2)}</div>
              <div className="text-[12px] text-muted">{d.budget ? `月上限 ¥${d.budget.perMonthCny}` : "预算未设"}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted">待你拍板</div>
              <div className={`text-2xl font-semibold tabular-nums ${pendingRules + pendingProposals > 0 ? "text-warn" : "text-fg"}`}>{pendingRules + pendingProposals}</div>
              <div className="text-[12px] text-muted">规则 {pendingRules} · 工单 {pendingProposals}</div>
            </div>
          </div>
        </div>
      </GlowPanel>

      {/* 例行动作（收编：流水线 + 诊断 + 规则审批 + 子开关） */}
      <Section
        id="ai-routine"
        title="例行动作（每日反思链条）"
        hint="小机每个交易日 15:03 的规定动作：诊断 → 因子层 → 策略层 → 基因组层。提议过闸由预登记判据说了算，小机无权修改。"
      >
        <div className="px-3.5 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={d.ai.autoEvolve} disabled={!masterOn} onChange={(e) => void toggleRoutine(e.target.checked)} className="accent-brand" />
              交易日 15:03 自动跑例行（子开关）
            </label>
            <span className="text-[12px] text-muted">判定数据：挑战者 {running} 在跑 / {judged} 已判</span>
          </div>
          {masterOn ? (
            <>
              <Pipeline stages={routineStages} />
              {todayRoutine.length === 0 ? (
                <p className="mt-2 text-[12px] text-muted">今天还没跑：交易日 15:03 收盘封印后自动触发；休市日不跑（数据没变，跑了也是白跑）。</p>
              ) : null}
            </>
          ) : (
            <StateBlock kind="empty" title="例行已随总开关停用" hint="打开顶部「小机在岗」恢复。" />
          )}
          {pendingRules > 0 ? (
            <div className="mt-3 rounded border border-warn bg-warn-soft px-3 py-2">
              <p className="text-xs font-medium text-warn">例行产物里有 {pendingRules} 条核心规则变更等你拍板</p>
              <div className="mt-2 flex flex-col gap-1.5">
                {d.rules.pending.filter((p) => p.status === "pending").map((p) => (
                  <div key={p.id} className="text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-warn">{p.key}：{p.from} → {p.to}</span>
                      <span className="text-[12px] text-muted">{p.at.slice(5, 16).replace("T", " ")}</span>
                    </div>
                    <p className="mt-0.5 text-muted">{p.why}</p>
                    <div className="mt-1 flex gap-2">
                      <button type="button" disabled={ruleBusy === p.id} onClick={() => void decideRule(p.id, "apply")} className="rounded-full border border-line bg-brand px-2.5 py-0.5 text-[12px] text-white disabled:opacity-40">批准</button>
                      <button type="button" disabled={ruleBusy === p.id} onClick={() => void decideRule(p.id, "reject")} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] text-muted disabled:opacity-40">驳回</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {d.diagnosis ? (
            <CollapsibleSection
              className="mt-3 overflow-hidden rounded border border-line bg-surface-2"
              storageKey="ai-routine-diagnosis-2026-11"
              defaultOpen={false}
              headerClassName="border-b border-line px-3.5 py-2"
              header={
                <span className="text-xs">
                  <span className="font-medium">最近诊断报告</span>
                  <span className="ml-2 text-muted">{d.diagnosis.at.slice(5, 16).replace("T", " ")}</span>
                </span>
              }
            >
              <div className="px-3.5 py-2.5 text-xs leading-relaxed">
                <p className="text-up">总评：{d.diagnosis.summary || "—"}</p>
                <p className="mt-1 text-muted">因子层：{d.diagnosis.factorLayer || "—"}</p>
                <p className="mt-0.5 text-muted">策略层：{d.diagnosis.strategyLayer || "—"}</p>
                {d.diagnosis.suggestions.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
                    {d.diagnosis.suggestions.slice(0, 5).map((s: string, i: number) => <li key={i}>{s}</li>)}
                  </ul>
                ) : null}
              </div>
            </CollapsibleSection>
          ) : null}
        </div>
      </Section>

      {/* 统一时间线（一本账） */}
      <Section
        id="ai-timeline"
        title="统一时间线（一本账）"
        hint="例行四层 + 手动派活 + 定时任务按时间混排；徽章区分来源。花费两条口径（例行按 usage 回填、派活自带），实打实不加总虚数。"
      >
        <div className="px-3.5 py-3">
          {timeline.length === 0 ? (
            <StateBlock kind="empty" title="还没有活动记录" hint="例行会在交易日 15:03 自动跑；想立刻看到它干活，去「岗位」页派个只读小任务。" />
          ) : (
            <Table className="data-table" caption="小机统一时间线：例行 + 派活 + 定时">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>时间</th>
                  <th className={thClass()}>来源</th>
                  <th className={thClass()}>状态</th>
                  <th className={thClass()}>花费</th>
                  <th className={thClass("text-left")}>内容</th>
                  <th className={thClass("text-left")}>明细</th>
                </tr>
              </thead>
              <tbody>
                {timeline.slice(0, 20).map((t: TimelineItem, i) => (
                  <tr key={`${t.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="whitespace-nowrap px-2.5 py-1.5 text-[12px] text-muted">{t.at.slice(5, 16).replace("T", " ")}</td>
                    <td data-l="来源" className="px-2.5 py-1.5"><Tag tone={sourceTone(t.source)}>{sourceLabel(t.source)}</Tag></td>
                    <td data-l="状态" className={`px-2.5 py-1.5 text-[12px] ${t.status === "ok" ? "text-up" : t.status === "running" ? "text-brand-text" : "text-down"}`}>
                      {t.status === "ok" ? "完成" : t.status === "running" ? "进行中" : t.status === "budget-killed" ? "超预算" : "失败"}
                    </td>
                    <td data-l="花费" className="px-2.5 py-1.5 font-mono text-[12px] text-fg">{t.costCny != null ? `¥${t.costCny.toFixed(2)}` : "—"}</td>
                    <td data-l="内容" className="max-w-[30ch] px-2.5 py-1.5 text-[12px] text-fg" title={t.title}>{t.title}</td>
                    <td data-l="明细" className="max-w-[36ch] truncate px-2.5 py-1.5 text-[12px] text-muted" title={t.detail ?? undefined}>{t.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="mt-2 text-[12px] text-muted">要看单次调用的 token/模型/耗时流水，去「账目」页；要派新的活，去「岗位」页。</p>
        </div>
      </Section>

      {/* 工单收件箱 */}
      <Section
        id="ai-proposals-inbox"
        title="工单收件箱"
        hint="小机干活时「顺手发现」的问题：批准 = 转成派活草稿，你再去岗位页确认发送。驳回 = 否决。它自己没有动手入口。"
      >
        <div className="px-3.5 py-3">
          {d.proposals.length === 0 ? (
            <StateBlock kind="empty" title="没有工单" hint="小机发现问题时会写到这里等你拍板。" />
          ) : (
            <div className="flex flex-col gap-2">
              {[...d.proposals].reverse().slice(0, 8).map((p) => (
                <div key={p.id} className={`rounded border px-3 py-2 text-xs ${p.status === "pending" ? "border-warn bg-warn-soft" : "border-line bg-surface-2"}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[12px] text-muted">{p.at.slice(5, 16).replace("T", " ")}</span>
                    <Tag tone={p.status === "pending" ? "warn" : p.status === "approved" ? "up" : "muted"}>
                      {p.status === "pending" ? "待拍板" : p.status === "approved" ? "已批准（去岗位页发送）" : "已驳回"}
                    </Tag>
                  </div>
                  <p className="mt-1 leading-relaxed text-fg">{p.finding}</p>
                  {p.suggestion ? <p className="mt-0.5 text-muted">建议：{p.suggestion}</p> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      <p className="mt-3 px-1 text-[12px] leading-relaxed text-warn">
        边界不变：小机与例行链条都只有提议权，判决函数写死在代码里；核心阈值变更永远等人拍板。谁能改什么，见「法条」页。
      </p>
    </Frame>
  );
}
