/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「AI 控制中枢」子页（/ai）。自我迭代闭环的控制台：健康总览、
 * 六阶段进化流水线、手动跑一轮完整进化（因子层 → 策略层）、自动进化开关、
 * 每轮提议/被拒的运行账本。
 *
 * 你需要知道的：
 * - 2026-11-06 按 AI 区新效果图从「进化控制台」重排成「AI 控制中枢」；
 *   功能一件没删——跑进化/跑诊断/自动开关/规则审批/诊断报告/VT 工具都在。
 * - 健康分是**四个真实检查项**（模型服务可用且近 7 天成功率没崩、自动记账新鲜、
 *   行情通道有数据、挑战者判决机制有档案）各占 25 分算出来的，构成写在环的
 *   title 里。效果图那个「96」是拍脑袋的，不能抄。
 * - AI 每轮提议都进账本，下一轮 prompt 会读到这些提议的下场（过没过 6 关、
 *   转正还是淘汰），据此纠错。AI 能做什么、不能碰什么，全文见 AI-BOUNDARY.md。
 * - 因子待验队列 / 挑战者提名在因子页的 AI 闭环面板里，不在这里。
 */

import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { CollapsibleSection } from "@/components/collapsible";
import { AiStat, GlowPanel, HealthRing, MiniBars, Pipeline, type PipelineStage } from "@/components/ai-kit";
import {
  applyRuleChange,
  getAILog,
  getAIStatus,
  getAIUsage,
  getAgentDiagnosis,
  getChallengers,
  getIndices,
  getPendingRuleChanges,
  getRuleChangeEffects,
  getRecorder,
  getVTToolsStatus,
  rejectRuleChange,
  runAgentDiagnose,
  runEvolve,
  saveAIPrefs,
} from "@/lib/market/quotes.functions";
import type { AILogEntry } from "@/lib/market/ai-log";
import type { AIUsageEntry } from "@/lib/market/ai-usage";
import { AISectionTabs, Section, type AIStatusPayload } from "@/components/ai-panels";
import { Eye, Lightbulb, ShieldCheck, Gauge, UserCheck, Play, CheckCircle2, CircleDashed } from "lucide-react";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

/** 上海时区当天 0 点的 ISO 串（账本/AI 账都按上海日）。now 由调用方传（loader 下发），
 *  不在 render 里读系统时钟——否则跨日边界 SSR/hydration 会对不上，触发 #418。 */
function shanghaiDayStartIso(offsetDays: number, now: number): string {
  const DAY = 86_400_000;
  const OFF = 8 * 3_600_000;
  return new Date(Math.floor((now + OFF) / DAY) * DAY - OFF + offsetDays * DAY).toISOString();
}

const DAY = 86_400_000;

export const Route = createFileRoute("/ai/")({
  loader: async () => {
    const [ai, logRes, diagnosis, vtRes, rulesRes, effectsRes, usageRes, chalRes, recorder, indices] = await Promise.all([
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [], fallbackOrder: [] })),
      getAILog().catch((): { allowed: boolean; entries: AILogEntry[] } => ({ allowed: false, entries: [] })),
      getAgentDiagnosis().catch(() => null),
      getVTToolsStatus().catch(() => ({ allowed: false as const })),
      getPendingRuleChanges().catch(() => ({ pending: [], log: [] })),
      getRuleChangeEffects().catch(() => ({ effects: [] as never[], why: "读不到" })),
      getAIUsage().catch((): { allowed: false; entries: AIUsageEntry[]; stats: null } => ({ allowed: false, entries: [], stats: null })),
      getChallengers().catch(() => ({ list: [] as { id: string; status: string }[], champions: {}, rule: null })),
      getRecorder().catch(() => ({ at: null as number | null, ok: true })),
      getIndices().catch(() => []),
    ]);
    return {
      ai,
      log: logRes.entries,
      diagnosis,
      vt: vtRes.allowed ? vtRes.status : null,
      rules: rulesRes,
      effects: effectsRes.effects,
      usage: usageRes,
      chal: chalRes.list,
      chalRule: chalRes.rule,
      recorder,
      indexCount: indices.length,
      // 健康分里的「自动记账多久前」依赖当前时刻：放进 loader 算一次、随 loader 数据序列化，
      // SSR 与 hydration 拿到同一个值，不会因时刻差触发 #418。
      serverNow: Date.now(),
    };
  },
  component: AIConsolePage,
});

function AIConsolePage() {
  const d = Route.useLoaderData();
  const { serverNow } = d;
  const router = useRouter();
  const [evolveMsg, setEvolveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"evolve" | "diagnose" | null>(null);
  const [ruleBusy, setRuleBusy] = useState<string | null>(null);

  /** 批准/驳回一条待确认的核心规则变更。批准才真正写 data/challenger-rule.json。 */
  const decideRule = async (id: string, action: "apply" | "reject") => {
    setRuleBusy(id);
    setEvolveMsg(null);
    try {
      const res =
        action === "apply"
          ? await applyRuleChange({ data: { id } })
          : await rejectRuleChange({ data: { id } });
      setEvolveMsg(res.ok ? (action === "apply" ? "已批准，写入规则文件" : "已驳回") : (("error" in res && res.error) || "操作失败"));
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "操作失败");
    } finally {
      setRuleBusy(null);
    }
  };

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

  /** 一键完整进化：全局诊断（观察）→ 因子层 → 策略层 → 基因组层，各层各自记账。 */
  const runEvolveOnce = async () => {
    setBusy("evolve");
    setEvolveMsg(null);
    try {
      const res = await runEvolve();
      const part = (label: string, r: { ok: boolean; proposed: number; error?: string }): string =>
        `${label} ${r.ok ? `进 ${r.proposed} 个` : `没跑成（${r.error ?? "?"}）`}`;
      const diag = res.agent ? (res.agent.ok ? `诊断 ok（${res.agent.diagnosis?.summary ?? ""}）` : `诊断没跑成（${res.agent.error ?? "?"}）`) : "诊断缺席";
      setEvolveMsg(
        `${diag} · ${part("因子层", res.factor)} · ${part("策略层", res.strategy)} · ${part("基因组层", res.genome)}。` +
          `诊断的建议本轮就进了两层 prompt；两层的下场下一轮自己读账纠错。`,
      );
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  /** 自动进化开关：收盘后记账进程每天自动跑一轮；失败的层当天自动补跑（上限 3 次、间隔 30 分钟）。 */
  const toggleAuto = async (next: boolean) => {
    try {
      await saveAIPrefs({ data: { autoEvolve: next } });
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "保存开关失败");
    }
  };

  // ── 真实计数 ──────────────────────────────────────────────────────────
  const todayIso = shanghaiDayStartIso(0, serverNow);
  const sevenIso = shanghaiDayStartIso(-6, serverNow);
  const todayProposed = d.log.filter((e) => e.at >= todayIso).reduce((a, e) => a + e.proposed.length, 0);
  const totalProposed = d.log.reduce((a, e) => a + e.proposed.length, 0);
  const totalRejected = d.log.reduce((a, e) => a + e.rejected.length, 0);
  const acceptRate = totalProposed + totalRejected > 0 ? Math.round((totalProposed / (totalProposed + totalRejected)) * 100) : null;
  const running = d.chal.filter((c) => c.status === "running").length;
  const judged = d.chal.filter((c) => c.status !== "running").length;
  const pending = d.rules.pending.filter((p) => p.status === "pending").length;
  const recent = d.usage.entries.filter((e) => e.at >= sevenIso);
  const recentOk = recent.filter((e) => e.ok).length;
  const successRate = recent.length > 0 ? Math.round((recentOk / recent.length) * 100) : null;
  const recorderFresh = d.recorder.at != null && serverNow - d.recorder.at < 5 * 60_000;

  // 健康分：四个真实检查项各 25 分，构成写在 title 里
  const checks = [
    {
      label: "模型服务",
      ok: d.ai.configured && (recent.length === 0 || (successRate ?? 0) >= 50),
      detail: !d.ai.configured
        ? "没有启用中的接口档案"
        : recent.length === 0
          ? "已配置（近 7 天无调用）"
          : `近 7 天成功率 ${successRate}%（${recent.length} 次）`,
    },
    { label: "自动记账", ok: recorderFresh, detail: d.recorder.at ? `${Math.round((serverNow - d.recorder.at) / 60_000)} 分钟前` : "还没跑" },
    { label: "行情通道", ok: d.indexCount > 0, detail: d.indexCount > 0 ? `拿得到 ${d.indexCount} 个指数` : "行情还没拉到" },
    { label: "判决机制", ok: d.chal.length > 0, detail: d.chal.length > 0 ? `挑战者档案 ${d.chal.length} 个` : "还没有挑战者档案" },
  ];
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  const allOk = checks.every((c) => c.ok);

  const stages: PipelineStage[] = [
    {
      icon: <Eye size={18} />, step: "01", title: "观察", desc: "全局诊断，读整个账本",
      metric: d.diagnosis ? `最近 ${d.diagnosis.at.slice(5, 16).replace("T", " ")}` : "还没跑过",
      done: !!d.diagnosis,
    },
    {
      icon: <Lightbulb size={18} />, step: "02", title: "提议", desc: "因子 / 策略 / 基因组三层",
      metric: `今日进 ${todayProposed} 条`,
      done: totalProposed > 0,
    },
    {
      icon: <ShieldCheck size={18} />, step: "03", title: "校验", desc: "白名单 / 六关，不过就拒",
      metric: acceptRate != null ? `入队率 ${acceptRate}%` : "暂无提议",
      done: totalProposed > 0,
    },
    {
      icon: <Gauge size={18} />, step: "04", title: "评估", desc: `挑战者攒够 ${d.chalRule?.minTrades ?? "?"} 笔后 Welch t 判决`,
      metric: `在跑 ${running} · 已判 ${judged}`,
      done: judged > 0,
    },
    {
      icon: <UserCheck size={18} />, step: "05", title: "人工确认", desc: "核心阈值变更等拍板",
      metric: pending > 0 ? `待确认 ${pending} 条` : "无待办",
      done: pending === 0,
      waiting: pending > 0,
    },
    {
      icon: <Play size={18} />, step: "06", title: "执行", desc: "模拟盘按判决记账",
      metric: recorderFresh ? "自动记账正常" : "记账停了",
      done: recorderFresh,
    },
  ];
  const doneCount = stages.filter((s) => s.done).length;

  const proposals = [...d.log]
    .flatMap((e) => e.proposed.map((p) => ({ name: p.name, layer: e.layer, at: e.at })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 6);

  const layerName = (l: string): string => (l === "factor" ? "因子" : l === "agent" ? "诊断" : l === "genome" ? "基因组" : "策略");

  return (
    <Frame wide aside="AI 管理 · AI 控制中枢" decorHeader={false}>
      <PixelHeader label="AI // WORKBENCH" meta="AI 只在研究层跑，不直接下单" />
      <PixelSummary
        label="AI // NOW"
        note="只在研究层跑，不直接下单"
        stats={[
          { label: "今日提议", value: todayProposed, tone: "brand", hero: true },
          { label: "累计提议", value: totalProposed },
          { label: "累计被拒", value: totalRejected, tone: "warn" },
          { label: "挑战者", value: `${running}/${running + judged}`, hint: "在跑 / 总" },
          { label: "待批规则", value: pending, tone: pending > 0 ? "up" : "muted" },
        ]}
      />
      <AISectionTabs />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-xl font-medium tracking-wide">AI 控制中枢</h1>
        <span className="text-xs text-muted">让优秀的策略，持续进化</span>
      </div>

      {/* 健康总览 */}
      <GlowPanel className="mt-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-5">
          <HealthRing
            value={score}
            hint={`四个真实检查项各 25 分：${checks.map((c) => `${c.label} ${c.ok ? "✓" : "✗"}`).join(" · ")}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-lg font-medium text-fg">{allOk ? "AI 系统运行正常" : "AI 系统部分降级"}</p>
              <Tag tone={allOk ? "up" : "warn"}>{doneCount}/6 阶段有产出</Tag>
            </div>
            <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-muted">
              AI 持续观察市场、生成提议、过校验、攒样本评估——能自动生效的只有白名单表达式和纸面参数，
              核心阈值变更永远等人工拍板。
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {checks.map((c) => (
                <span
                  key={c.label}
                  title={c.detail}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] ${
                    c.ok ? "border-ai-line text-ai" : "border-warn/50 text-warn"
                  }`}
                >
                  {c.ok ? <CheckCircle2 size={11} /> : <CircleDashed size={11} />}
                  {c.label}
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-xs text-muted">今日提议</div>
              <div className="text-3xl font-semibold tabular-nums text-ai">{todayProposed}</div>
              <div className="text-[12px] text-muted">累计 {totalProposed}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted">待我确认</div>
              <div className={`text-3xl font-semibold tabular-nums ${pending > 0 ? "text-warn" : "text-fg"}`}>{pending}</div>
              <div className="text-[12px] text-muted">核心阈值变更</div>
            </div>
          </div>
        </div>
      </GlowPanel>

      {/* 控制条：跑进化 / 诊断 / 自动开关（功能保留，只是搬进新布局） */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3.5 py-2.5">
        {d.ai.allowed ? (
          <>
            <button
              type="button"
              disabled={busy !== null || !d.ai.configured}
              onClick={() => void runEvolveOnce()}
              className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "evolve" ? "AI 进化中…" : "跑一轮完整进化"}
            </button>
            <button
              type="button"
              disabled={busy !== null || !d.ai.configured}
              onClick={() => void runDiagnose()}
              className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "diagnose" ? "AI 诊断中…" : "跑一轮全局诊断"}
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={d.ai.autoEvolve} onChange={(e) => void toggleAuto(e.target.checked)} className="accent-brand" />
              收盘后每天自动进化一轮
            </label>
          </>
        ) : (
          <p className="text-xs text-muted">主人账号登录后可运行进化和开关自动模式。</p>
        )}
        {evolveMsg ? <span className="min-w-0 basis-full text-xs text-muted">{evolveMsg}</span> : null}
      </div>

      {/* 进化流水线 */}
      <Section
        id="ai-pipeline"
        title="策略进化流水线"
        hint="从市场观察到策略执行，AI 全流程驱动；每一步的数字都是账本里的真实计数。"
      >
        <div className="px-3.5 py-3">
          <Pipeline stages={stages} />
          <p className="mt-2 text-[12px] text-muted">
            {pending > 0
              ? `进化卡在第 5 步：${pending} 条核心阈值变更等你批准（见下方「待确认规则变更」）。`
              : `已完成 ${doneCount}/6 个阶段。`}
          </p>
        </div>
      </Section>

      <div className="mt-3 grid items-start gap-3 xl:grid-cols-[1fr_340px]">
        {/* 最新提议 */}
        <Section id="ai-proposals" title="最新提议" hint="AI 各层最近提出的候选，是否入队/过关由预登记的判据说了算。">
          {proposals.length > 0 ? (
            <ul className="divide-y divide-line">
              {proposals.map((p, i) => (
                <li key={`${p.at}-${p.name}-${i}`} className="flex items-center gap-2.5 px-3.5 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-fg">{p.name}</span>
                    <span className="text-[12px] text-muted">{p.at.slice(5, 16).replace("T", " ")}</span>
                  </span>
                  <Tag tone={p.layer === "factor" ? "brand" : "muted"}>{layerName(p.layer)}</Tag>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock kind="empty" title="还没有提议" hint="点上面的「跑一轮完整进化」，或开自动进化让记账进程收盘后自己跑。" />
          )}
        </Section>

        {/* 关键指标 */}
        <Section id="ai-metrics" title="关键指标" hint="全部从 AI 运行账本直接求和，不加工。">
          <div className="grid grid-cols-2 gap-2 p-3">
            <AiStat label="提议总数" value={totalProposed} sub={`被拒 ${totalRejected}`} bars={d.usage.stats?.last7Days.map((x) => x.tokens) ?? []} />
            <AiStat label="提议入队率" value={acceptRate != null ? `${acceptRate}%` : "—"} sub="入队 ÷（入队 + 被拒）" />
            <AiStat label="已判决挑战者" value={judged} sub={`在跑 ${running} 个`} />
            <AiStat label="近 7 天 AI 调用" value={recent.length} sub={successRate != null ? `成功率 ${successRate}%` : "无调用"} bars={recent.map((_, i) => recent.length - i)} />
          </div>
        </Section>
      </div>

      {/* 运行账本 */}
      <Section
        id="ai-ledger"
        title="系统活动日志"
        hint="AI 运行账本：每轮提议、被拒原因都记着，下一轮 prompt 会读到这些下场，据此纠错。"
      >
        <div className="px-3.5 py-3">
          {d.log.length > 0 ? (
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
                {[...d.log].reverse().slice(0, 20).map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="px-2.5 py-1.5 whitespace-nowrap text-[12px] text-muted">
                      {e.at.slice(0, 16).replace("T", " ")}
                    </td>
                    <td data-l="层" className="px-2.5 py-1.5">
                      <Tag tone={e.ok ? "muted" : "warn"}>{layerName(e.layer)}</Tag>
                    </td>
                    <td data-l="触发" className="px-2.5 py-1.5 text-[12px] text-muted">
                      {e.trigger === "auto" ? "自动" : "手动"}
                    </td>
                    <td data-l="结果" className={`px-2.5 py-1.5 text-[12px] ${e.ok ? "text-up" : "text-down"}`}>
                      {e.ok ? `进 ${e.proposed.length}` : "失败"}
                    </td>
                    <td data-l="提议" className="max-w-[28ch] px-2.5 py-1.5 text-[12px] text-muted">
                      {e.proposed.length > 0 ? e.proposed.map((p) => p.name).join("、") : "—"}
                    </td>
                    <td data-l="被拒" className="max-w-[32ch] px-2.5 py-1.5 text-[12px] text-muted">
                      {e.error ?? (e.rejected.length > 0 ? e.rejected.slice(0, 2).join("；") : "—")}
                    </td>
                    {e.note ? (
                      <td data-l="备注" className="max-w-[36ch] truncate px-2.5 py-1.5 text-[12px] text-warn" title={e.note}>
                        {e.note}
                      </td>
                    ) : (
                      <td data-l="备注" className="px-2.5 py-1.5 text-[12px] text-muted">—</td>
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

      {/* 待确认规则变更（混合审批的人工闸口） */}
      <Section
        id="rule-changes"
        title="待确认规则变更（优化闭环）"
        hint="混合审批：纸面参数类规则（提前否决时间盒）优化循环自动生效并留审计；核心判决阈值（起判笔数 / Welch t / 淘汰线）只进这里，你点「批准」才会写进判决规则。"
      >
        <div className="px-3.5 py-3">
          {pending === 0 ? (
            <StateBlock
              kind="empty"
              title="没有待确认的规则变更"
              hint="优化循环认为某条核心判决阈值该改时，会把「改成多少 + 为什么」放这里等你拍板。自动生效的纸面参数在下方审计里能看到。"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {d.rules.pending
                .filter((p) => p.status === "pending")
                .map((p) => (
                  <div key={p.id} className="rounded border border-warn bg-warn-soft px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-warn">
                        {p.key}：{p.from} → {p.to}
                      </span>
                      <span className="text-[12px] text-muted">{p.at.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    <p className="mt-1 leading-relaxed text-muted">{p.why}</p>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        type="button"
                        disabled={ruleBusy === p.id}
                        onClick={() => void decideRule(p.id, "apply")}
                        className="rounded-full border border-line bg-brand px-2.5 py-1 text-[12px] text-white disabled:opacity-40"
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        disabled={ruleBusy === p.id}
                        onClick={() => void decideRule(p.id, "reject")}
                        className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-muted disabled:opacity-40"
                      >
                        驳回
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {d.rules.log.length > 0 ? (
            <div className="mt-3 border-t border-line pt-2">
              <p className="mb-1 text-[12px] font-medium text-muted">
                最近规则变更审计
                <span className="ml-2 font-normal">· 右侧是改完之后的回验结论（观察期满才有）</span>
              </p>
              <ul className="flex flex-col gap-1 text-[12px] text-muted">
                {d.rules.log.slice(0, 8).map((a, i) => {
                  // 按 at+key 关联回验结论：同一条改动可能被回验多次（样本在长），取最新那条。
                  const fx = (d.effects as { at: string; key: string; verdict: string; reason: string; revertAdvice: string | null }[])
                    .filter((e) => e.at === a.at && e.key === a.key)[0];
                  const tone =
                    fx?.verdict === "effective" ? "text-down"
                      : fx?.verdict === "ineffective" ? "text-warn"
                        : "text-muted";
                  const label =
                    fx == null ? "还没回验"
                      : fx.verdict === "effective" ? "有效·保留"
                        : fx.verdict === "ineffective" ? "无效·建议回滚"
                          : fx.verdict === "pending" ? "观察中"
                            : "样本不足";
                  return (
                    <li key={`${a.at}-${a.key}-${i}`} className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                      <span>
                        {a.at.slice(0, 16).replace("T", " ")} · {a.mode === "auto" ? "自动" : a.mode === "approved" ? "人工批准" : "驳回"} · {a.key} {a.from}→{a.to}
                      </span>
                      <span className={"shrink-0 font-medium " + tone} title={fx?.reason ?? ""}>[{label}]</span>
                      {fx?.revertAdvice ? <span className="text-[11px] text-muted">{fx.revertAdvice}</span> : null}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                回验判据：改动后 ≥10 个交易日 + 前后各 ≥30 笔 + 差值超 ±0.3pp 噪声区才下结论。
                <span className="text-fg">「无效」只给回滚建议，不会自动改回去</span>——撤规则和改规则一样要人拍板。
              </p>
            </div>
          ) : null}
        </div>
      </Section>

      {/* 全局诊断报告 */}
      <Section
        id="ai-diagnosis"
        title="全局诊断报告"
        hint="AI 大脑的「观察」层：把因子判决史、队列、死因档案、挑战者、策略闸整个账本摊给它，出一份诊断。只诊断不行动——建议要走提议通道，规则变更只生成请求给人拍板。"
      >
        <div className="px-3.5 py-3">
          {d.diagnosis ? (
            <div className="space-y-2.5 text-xs leading-relaxed">
              <p className="text-[12px] text-muted">诊断时间：{d.diagnosis.at.slice(0, 16).replace("T", " ")}</p>
              <div>
                <p className="mb-0.5 font-medium text-up">总评</p>
                <p>{d.diagnosis.summary || "—"}</p>
              </div>
              <div>
                <p className="mb-0.5 font-medium">因子层</p>
                <p className="text-muted">{d.diagnosis.factorLayer || "—"}</p>
              </div>
              <div>
                <p className="mb-0.5 font-medium">策略层</p>
                <p className="text-muted">{d.diagnosis.strategyLayer || "—"}</p>
              </div>
              {d.diagnosis.suggestions.length > 0 ? (
                <div>
                  <p className="mb-0.5 font-medium">建议动作</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-muted">
                    {d.diagnosis.suggestions.map((s: string, i: number) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {d.diagnosis.ruleChangeRequests.length > 0 ? (
                <div>
                  <p className="mb-0.5 font-medium text-warn">规则变更请求（需主人拍板，AI 无权直接改）</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-warn">
                    {d.diagnosis.ruleChangeRequests.map((s: string, i: number) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {d.diagnosis.numberCheck ? (
                d.diagnosis.numberCheck.ungrounded.length > 0 ? (
                  <div className="rounded border border-warn bg-warn-soft px-2.5 py-2">
                    <p className="mb-0.5 font-medium text-warn">
                      数字核验：{d.diagnosis.numberCheck.ungrounded.length} 个数在本轮账本快照里找不到出处
                    </p>
                    <p className="text-muted">
                      以下数字是模型自己说的，账本里没有——引用它们下结论前先核实：
                      {d.diagnosis.numberCheck.ungrounded.join("、")}
                    </p>
                  </div>
                ) : (
                  <p className="text-[12px] text-muted">数字核验通过：报告引用的数字全部能在本轮账本快照里找到出处。</p>
                )
              ) : null}
            </div>
          ) : (
            <StateBlock kind="empty" title="还没有诊断报告" hint="点上面的「跑一轮全局诊断」；开自动进化后，收盘后每轮自动进化都是诊断先行，报告落在这里。" />
          )}
        </div>
      </Section>

      {/* VT 工具矿山：低频参考内容，默认收起 */}
      {d.vt ? (
        <CollapsibleSection
          className="mt-3 overflow-hidden rounded border border-line bg-surface"
          storageKey="ai-vt-tools-2026-11"
          defaultOpen={false}
          headerClassName="border-b border-line px-3.5 py-2"
          header={
            <span>
              <span className="text-sm font-medium">VT 工具矿山</span>
              <span className="ml-2 text-xs text-muted">
                {d.vt.online ? `在线 · ${d.vt.toolCount} 个只读研究工具` : "离线"}
              </span>
            </span>
          }
        >
          <div className="px-3.5 py-3">
            {d.vt.online ? (
              <div>
                <p className="mb-2 text-xs text-muted">Vibe-Trading 的 MCP server（stdio 子进程随用随起），检测于 {d.vt.checkedAt.slice(11, 19)}。</p>
                <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                  {d.vt.tools.slice(0, 24).map((t: { name: string; description?: string }) => (
                    <p key={t.name} className="truncate text-[12px] text-muted" title={t.description}>
                      <span className="font-mono text-foreground">{t.name}</span>
                      {t.description ? ` — ${t.description.slice(0, 40)}` : ""}
                    </p>
                  ))}
                </div>
                {d.vt.toolCount > 24 ? <p className="mt-1 text-[12px] text-muted">… 共 {d.vt.toolCount} 个，其余略</p> : null}
              </div>
            ) : (
              <StateBlock kind="empty" title="VT 工具离线" hint={`${d.vt.error ?? "未知原因"}。venv 路径可用 CHIHENG_VT_MCP_HOME 环境变量改。`} />
            )}
          </div>
        </CollapsibleSection>
      ) : (
        <div className="mt-3">
          <StateBlock kind="empty" title="工具状态未知" hint="主人账号登录后自动检测。" />
        </div>
      )}

      <p className="mt-3 px-1 text-[12px] leading-relaxed text-warn">
        AI 提议 ≠ 生效：因子要过 6 关，挑战者要攒够 {d.chalRule?.minTrades ?? "?"} 笔后过 Welch 判决；两个判决函数都预先登记在代码里，AI 无权修改。
      </p>
    </Frame>
  );
}
