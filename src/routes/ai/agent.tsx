/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「Agent 岗位」子页（/ai/agent）。常驻 agent（小机）的管理台：
 * 状态灯、派活输入框、任务账本（谁派的/花了多少/agent 回答了什么）、预算三档编辑。
 *
 * 你需要知道的：
 * - 默认待命：没有派活就没有进程、零消耗。面板上「待命」= 现在一分钱不花。
 * - 预算三级闸（单任务/单日/单月）在 agent-jobs.ts 的纯函数里，改预算走
 *   saveAgentBudget server fn（主人专属）。
 * - agent 的最终回答完整存账本（前 4000 字），页面折叠展示——派活的历史
 *   就是它的「工作交接记录」。
 * - 全操作权限是用户 2026-11-14 拍板的（DSH_PERMISSION_MODE=danger-full-access）；
 *   这页只管派活和看账，权力边界写在员工守则（agent-charter.ts）里。
 */

import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { AISectionTabs, Section } from "@/components/ai-panels";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";
import { dispatchAgentJob, getAgentJobs, getAgentSchedules, saveAgentBudget, saveAgentSchedule, decideAgentProposal } from "@/lib/market/quotes.functions";
import type { AgentJob } from "@/lib/market/agent-jobs";
import type { AgentSchedule, AgentProposal } from "@/lib/market/agent-schedules";

export const Route = createFileRoute("/ai/agent")({
  loader: async () => {
    const [res, sched] = await Promise.all([
      getAgentJobs().catch(() => ({ allowed: false as const, jobs: [] as AgentJob[], budget: null })),
      getAgentSchedules().catch(() => ({ allowed: false as const, schedules: [] as AgentSchedule[], proposals: [] as AgentProposal[] })),
    ]);
    return { res, sched, serverNow: Date.now() };
  },
  component: AgentPage,
});

const statusTone = (s: AgentJob["status"]): "up" | "down" | "warn" | "muted" =>
  s === "ok" ? "up" : s === "error" ? "down" : s === "budget-killed" ? "warn" : "muted";
const statusLabel = (s: AgentJob["status"]): string =>
  s === "ok" ? "完成" : s === "error" ? "失败" : s === "budget-killed" ? "超预算终止" : "进行中";

/** 一条定时任务：开关 + 小时 + 预算都在一行改。 */
function ScheduleRow({ s }: { s: AgentSchedule }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [hour, setHour] = useState(String(s.hourLocal));
  const [budget, setBudget] = useState(String(s.budgetCny));

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      await saveAgentSchedule({
        data: { id: s.id, enabled, hourLocal: Number(hour), budgetCny: Number(budget) },
      });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
        <input
          type="checkbox"
          checked={s.enabled}
          disabled={busy}
          onChange={(e) => void save(e.target.checked)}
          className="accent-brand"
        />
        <span className="font-medium">{s.id}</span>
      </label>
      <span className="min-w-0 flex-1 basis-64 truncate text-[12px] text-muted" title={s.task}>{s.task}</span>
      <span className="flex items-center gap-1 text-[12px] text-muted">
        每天
        <input
          type="number"
          min={0}
          max={23}
          value={hour}
          onChange={(e) => setHour(e.target.value)}
          onBlur={() => void save(s.enabled)}
          className="w-14 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-center font-mono text-[12px] text-fg focus:border-brand focus:outline-none"
        />
        点 · ≤¥
        <input
          type="number"
          min={0.1}
          step={0.5}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={() => void save(s.enabled)}
          className="w-16 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-center font-mono text-[12px] text-fg focus:border-brand focus:outline-none"
        />
      </span>
      {s.lastRunDay ? (
        <span className="font-mono text-[12px] text-muted">
          上次 {s.lastRunDay.slice(5)}{" "}
          <Tag tone={s.lastStatus === "ok" ? "up" : s.lastStatus === "error" ? "down" : "warn"}>
            {s.lastStatus === "ok" ? `¥${(s.lastCost ?? 0).toFixed(2)}` : s.lastStatus === "error" ? "失败" : "超预算"}
          </Tag>
        </span>
      ) : (
        <span className="text-[12px] text-muted">还没跑过</span>
      )}
    </div>
  );
}

/** 一条建议工单：批准/驳回。 */
function ProposalRow({ p }: { p: AgentProposal }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "approved" | "dismissed") => {
    setBusy(true);
    try {
      await decideAgentProposal({ data: { id: p.id, decision } });
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };

  const tone = p.status === "pending" ? "warn" : p.status === "approved" ? "up" : "muted";
  return (
    <div className={`rounded border px-3 py-2 text-xs ${p.status === "pending" ? "border-warn bg-warn-soft" : "border-line bg-surface-2"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] text-muted">
          {p.at.slice(5, 16).replace("T", " ")} · 来自任务 {p.jobAt.slice(5, 16).replace("T", " ")}
        </span>
        <Tag tone={tone}>{p.status === "pending" ? "待拍板" : p.status === "approved" ? "已批准" : "已驳回"}</Tag>
      </div>
      <p className="mt-1 leading-relaxed text-fg">{p.finding}</p>
      {p.suggestion ? <p className="mt-1 leading-relaxed text-muted">建议：{p.suggestion}</p> : null}
      {p.status === "pending" ? (
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("approved")}
            className="rounded-full border border-line bg-brand px-2.5 py-1 text-[12px] text-white disabled:opacity-40"
          >
            批准（转派活草稿）
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide("dismissed")}
            className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-muted disabled:opacity-40"
          >
            驳回
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AgentPage() {
  const d = Route.useLoaderData();
  const router = useRouter();
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string>(
    d.res.budget ? `${d.res.budget.perTaskCny},${d.res.budget.perDayCny},${d.res.budget.perMonthCny}` : "",
  );
  const [budgetMsg, setBudgetMsg] = useState<string | null>(null);

  const running = d.res.jobs.filter((j) => j.status === "running");
  const done = d.res.jobs.filter((j) => j.status !== "running");
  const spentToday = done
    .filter((j) => j.at.slice(0, 10) === new Date(d.serverNow).toISOString().slice(0, 10))
    .reduce((a, j) => a + (j.cost?.cny ?? 0), 0);
  const spentMonth = done
    .filter((j) => j.at.slice(0, 7) === new Date(d.serverNow).toISOString().slice(0, 7))
    .reduce((a, j) => a + (j.cost?.cny ?? 0), 0);

  const dispatch = async () => {
    if (!task.trim() || busy) return;
    setBusy(true);
    setAnswer(null);
    setError(null);
    try {
      const res = await dispatchAgentJob({ data: { task: task.trim() } });
      if (res.ok) {
        setAnswer(res.answer || "（agent 没有返回正文，看账本里的原始记录）");
        setTask("");
      } else {
        setError(res.error ?? "派活失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "派活失败");
    } finally {
      setBusy(false);
      await router.invalidate();
    }
  };

  const saveBudget = async () => {
    setBudgetMsg(null);
    const parts = budgetDraft.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      setBudgetMsg("格式：单任务,单日,单月（三个正数，逗号分隔）");
      return;
    }
    try {
      const res = await saveAgentBudget({ data: { perTaskCny: parts[0], perDayCny: parts[1], perMonthCny: parts[2] } });
      setBudgetMsg(res.ok ? "预算已生效" : (res.error ?? "保存失败"));
      await router.invalidate();
    } catch (err) {
      setBudgetMsg(err instanceof Error ? err.message : "保存失败");
    }
  };

  if (!d.res.allowed) {
    return (
      <Frame aside="AI 管理 · Agent 岗位" decorHeader={false}>
        <AISectionTabs />
        <div className="mt-3">
          <StateBlock kind="empty" title="主人账号登录后可管理小机" hint="派活、看账、调预算都是主人专属。" />
        </div>
      </Frame>
    );
  }

  return (
    <Frame aside="AI 管理 · Agent 岗位" decorHeader={false}>
      <PixelHeader label="AGENT // STATION" meta="默认待命 · 没有任务就没有进程、零消耗" />
      <PixelSummary
        label="AGENT // NOW"
        note="全操作权限 · 权力边界见员工守则（agent-charter.ts）"
        stats={[
          { label: "当前", value: running.length > 0 ? "任务中" : "待命", tone: running.length > 0 ? "brand" : "muted", hero: true },
          { label: "今日已花", value: `¥${spentToday.toFixed(2)}` },
          { label: "本月已花", value: `¥${spentMonth.toFixed(2)}`, tone: d.res.budget && spentMonth > d.res.budget.perMonthCny * 0.8 ? "warn" : undefined },
          { label: "累计任务", value: d.res.jobs.length },
        ]}
      />
      <AISectionTabs />

      {/* 状态灯 + 派活 */}
      <Section
        id="agent-dispatch"
        title="派活"
        hint="任务描述尽量具体（做什么 + 验收标准）。agent 带着员工守则上岗：改账本/判决函数前会先说明，干完会报告花了多少。"
      >
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={3}
            placeholder="例如：检查最近 3 天的挑战者判决有没有异常，把可疑的列出来（只读任务）"
            className="w-full resize-y rounded border border-line bg-surface-2 px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-brand focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !task.trim()}
              onClick={() => void dispatch()}
              className="rounded bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "小机干活中…（可能要几分钟）" : "派活"}
            </button>
            {d.res.budget ? (
              <span className="text-[12px] text-muted">
                预算闸：单任务 ≤{d.res.budget.perTaskCny} 元 · 今日已花 ¥{spentToday.toFixed(2)}/{d.res.budget.perDayCny} 元
              </span>
            ) : null}
          </div>
          {busy && running.length > 0 ? (
            <p className="text-[12px] text-muted">
              正在跑：{running[0].task.slice(0, 60)}…（派出于 {running[0].at.slice(11, 19)}，跑完这页自动刷新）
            </p>
          ) : null}
          {error ? <p className="text-xs text-down">{error}</p> : null}
          {answer ? (
            <div className="rounded border border-line bg-surface-2 px-3 py-2.5">
              <p className="mb-1 text-[12px] font-medium text-up">小机的报告</p>
              <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-fg">{answer}</pre>
            </div>
          ) : null}
        </div>
      </Section>

      {/* 预算 */}
      <Section id="agent-budget" title="预算（元）" hint="三级闸：超限自动拒活/杀进程并推送。格式：单任务,单日,单月。">
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-3">
          <input
            type="text"
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            className="w-52 rounded border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-sm text-fg focus:border-brand focus:outline-none"
            placeholder="2,5,100"
          />
          <button
            type="button"
            onClick={() => void saveBudget()}
            className="rounded border border-brand px-2.5 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white"
          >
            保存
          </button>
          {budgetMsg ? <span className="text-[12px] text-muted">{budgetMsg}</span> : null}
        </div>
      </Section>

      {/* 任务账本 */}
      <Section
        id="agent-jobs"
        title="任务账本"
        hint="每次派活的完整记录：谁派的、花了多少、agent 干了什么。这是审计底账，不是装饰。"
      >
        <div className="px-3.5 py-3">
          {d.res.jobs.length === 0 ? (
            <StateBlock kind="empty" title="还没有派过活" hint="小机默认待命。第一次派活建议给个只读任务试试水。" />
          ) : (
            <Table className="data-table" caption="agent 任务账本">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>时间</th>
                  <th className={thClass()}>触发</th>
                  <th className={thClass()}>状态</th>
                  <th className={thClass()}>花费</th>
                  <th className={thClass("text-left")}>任务</th>
                  <th className={thClass("text-left")}>回答 / 报错</th>
                </tr>
              </thead>
              <tbody>
                {[...d.res.jobs].reverse().slice(0, 30).map((j, i) => (
                  <tr key={`${j.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="whitespace-nowrap px-2.5 py-1.5 text-[12px] text-muted">{j.at.slice(5, 16).replace("T", " ")}</td>
                    <td data-l="触发" className="px-2.5 py-1.5 text-[12px] text-muted">{j.trigger === "manual" ? "手动" : "定时"}</td>
                    <td data-l="状态" className="px-2.5 py-1.5"><Tag tone={statusTone(j.status)}>{statusLabel(j.status)}</Tag></td>
                    <td data-l="花费" className="px-2.5 py-1.5 font-mono text-[12px] text-fg">
                      {j.cost ? `¥${j.cost.cny.toFixed(3)}` : "—"}
                    </td>
                    <td data-l="任务" className="max-w-[30ch] px-2.5 py-1.5 text-[12px] text-muted" title={j.task}>
                      {j.task.slice(0, 50)}{j.task.length > 50 ? "…" : ""}
                    </td>
                    <td data-l="回答" className="max-w-[40ch] px-2.5 py-1.5 text-[12px] text-muted">
                      {j.answer ? (
                        <details>
                          <summary className="cursor-pointer text-brand">看回答（{j.answer.length} 字）</summary>
                          <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed">{j.answer}</pre>
                        </details>
                      ) : (j.error ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Section>

      {/* 定时任务清单 */}
      {d.sched.allowed ? (
        <Section
          id="agent-schedules"
          title="定时任务"
          hint="预先登记的自动化（口子②）：每条独立开关 + 独立预算，每天最多跑一次。默认全部关闭——逐条审过再开。"
        >
          <div className="flex flex-col divide-y divide-line px-3.5 py-2">
            {d.sched.schedules.map((s) => (
              <ScheduleRow key={s.id} s={s} />
            ))}
          </div>
        </Section>
      ) : null}

      {/* 建议工单收件箱 */}
      {d.sched.allowed ? (
        <Section
          id="agent-proposals"
          title="建议工单"
          hint="小机干活时「顺手发现」的问题（口子③）：批准后会生成一条预填派活草稿，你再去上面「派活」框里确认发送。驳回 = 不留痕的否决。"
        >
          <div className="px-3.5 py-3">
            {d.sched.proposals.length === 0 ? (
              <StateBlock kind="empty" title="没有工单" hint="小机发现问题时会写到这里等你拍板；它自己没有动手的入口。" />
            ) : (
              <div className="flex flex-col gap-2">
                {[...d.sched.proposals].reverse().slice(0, 10).map((p) => (
                  <ProposalRow key={p.id} p={p} />
                ))}
              </div>
            )}
          </div>
        </Section>
      ) : null}

      <p className="mt-3 px-1 text-[12px] leading-relaxed text-warn">
        权力边界：小机有全操作权限（读改文件、跑命令），但账本和判决函数改动前必须先说明理由；
        真实下单永远不在能力范围内。每次派活自动记账，预算超限自动熔断。
      </p>
    </Frame>
  );
}
