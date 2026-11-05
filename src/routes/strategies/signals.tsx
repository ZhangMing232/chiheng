/**
 * 每日信号：收盘初筛候选 + 竞价审核结果 + 次日战绩统计。
 * 从 /arena 拆出来的子页面。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { SectionTabs } from "@/components/section-tabs";
import { CollapsibleSection } from "@/components/collapsible";
import { STRATEGY_TABS } from "@/lib/ui/strategy-tabs";
import { Zap, AlertTriangle, CheckCircle, Trophy, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { getSignalCandidates, getSignalReviewed, getSignalTracking } from "@/lib/market/quotes.functions";
import type { SignalCandidate, SignalReviewed, SignalTrackItem, SignalTrackSummary } from "@/lib/market/quotes.functions";


export const Route = createFileRoute("/strategies/signals")({
  loader: async () => {
    const [c, r, t] = await Promise.all([
      getSignalCandidates().catch(() => ({ signals: [] as SignalCandidate[] })),
      getSignalReviewed().catch(() => ({ signals: [] as SignalReviewed[] })),
      getSignalTracking().catch(() => ({ signalDate: "", trackedDate: "", summary: null as SignalTrackSummary | null, signals: [] as SignalTrackItem[] })),
    ]);
    return { candidates: c.signals, reviewed: r.signals, tracking: t };
  },
  component: ArenaSignals,
});

function SignalCards({ title, signals, variant }: { title: string; signals: SignalCandidate[] | SignalReviewed[]; variant: "candidate" | "reviewed" }) {
  if (signals.length === 0) return null;
  const isReviewed = variant === "reviewed";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {isReviewed ? <CheckCircle size={12} className="text-up" /> : <Zap size={12} className="text-brand" />}
        <span>{title} ({signals.length})</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {signals.map((s, i) => {
          const r = s as SignalReviewed;
          const hasReview = isReviewed && r.verdict;
          return (
          <div key={`${s.id}-${i}`} className={`flex flex-col gap-1 rounded border p-2.5 text-xs ${
            hasReview
              ? r.verdict === "ok" ? "border-up/40 bg-up/5" : r.verdict === "warn" ? "border-yellow-500/40 bg-yellow-500/5" : "border-line bg-surface"
              : "border-line bg-surface"
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm">{s.name}</span>
                <span className="text-[10px] text-muted tabular-nums">{s.code}</span>
              </div>
              {hasReview && r.verdict === "ok" && <CheckCircle size={12} className="text-up" />}
              {hasReview && r.verdict === "warn" && <AlertTriangle size={12} className="text-yellow-500" />}
            </div>
            <div className="flex items-center gap-2 text-muted">
              <span className="rounded bg-surface2 px-1 py-0.5 text-[10px]">{s.strategy}</span>
              <span className="tabular-nums">挂 {s.buyPrice}</span>
            </div>
            <p className="text-[11px] text-muted">{s.reason}</p>
            {hasReview && r.verdictReason && (
              <p className={`text-[11px] ${r.verdict === "ok" ? "text-up" : "text-yellow-500"}`}>
                {r.verdict === "ok" ? "✓ " : "⚠ "}{r.verdictReason}
              </p>
            )}
            {hasReview && r.auctionGap != null && (
              <div className="flex gap-2 text-[10px] text-muted">
                <span>竞价 {r.auctionPrice}</span>
                <span className={r.auctionGap > 0 ? "text-up" : "text-down"}>
                  {r.auctionGap > 0 ? "+" : ""}{r.auctionGap}%
                </span>
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

function ArenaSignals() {
  const { candidates, reviewed, tracking } = Route.useLoaderData() as { candidates: SignalCandidate[]; reviewed: SignalReviewed[]; tracking: { signalDate: string; trackedDate: string; summary: SignalTrackSummary | null; signals: SignalTrackItem[] } | null };
  const hasSignals = candidates.length > 0 || reviewed.length > 0;

  return (
    <Frame aside="策略" wide>
      <Panel title="跟单信号" note="盘中实时候选看「策略选股」；这里是收盘后初筛、竞价后审核的定稿清单——你决定跟不跟。">
        <div className="flex flex-col gap-4 px-4 py-3">
          <SectionTabs tabs={STRATEGY_TABS} ariaLabel="策略子页面" />

          {tracking?.summary && tracking.summary.totalSignals > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded border border-line bg-surface2 px-4 py-3 text-sm">
              <span className="flex items-center gap-1.5 font-medium"><Trophy size={14} className="text-brand" /> 战绩（{tracking.signalDate} → {tracking.trackedDate}）</span>
              <span className={`tabular-nums font-medium ${tracking.summary.winRate >= 50 ? "text-up" : "text-down"}`}>胜率 {tracking.summary.winRate}%（{tracking.summary.wins}胜{tracking.summary.losses}负）</span>
              <span className="tabular-nums">盈亏比 {tracking.summary.plRatio}</span>
              <span className="tabular-nums text-muted">均赢 +{tracking.summary.avgWinPct}% / 均亏 {tracking.summary.avgLossPct}%</span>
              <div className="w-full border-t border-line/50" />
              <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                {Object.entries(tracking.summary.byStrategy).map(([s, v]) => (
                  <span key={s} className={`text-xs tabular-nums ${v.avgChg >= 0 ? "text-up" : "text-down"}`}>
                    {s}: {v.wins}胜{v.losses}负 均{v.avgChg >= 0 ? "+" : ""}{v.avgChg}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 逐条明细（原「战绩跟踪」页的内容）：同一份 tracking 数据，摘要在上、
              明细收进折叠区，不再单独占一个 tab。 */}
          {tracking && tracking.signals.length > 0 ? (
            <CollapsibleSection
              storageKey="ch-collapse-signal-tracking"
              defaultOpen={false}
              header={
                <>
                  <h2 className="text-sm font-medium">逐条明细</h2>
                  <p className="text-xs text-muted">{tracking.signals.length} 条信号 · 挂单价 vs 次日收盘的完整记录</p>
                </>
              }
            >
              <div className="overflow-hidden rounded border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-surface2 text-left text-muted">
                    <tr>
                      <th className="px-3 py-2">代码</th>
                      <th className="px-3 py-2">名称</th>
                      <th className="px-3 py-2">策略</th>
                      <th className="px-3 py-2 text-right">挂单价</th>
                      <th className="px-3 py-2 text-right">昨收</th>
                      <th className="px-3 py-2 text-right">今收</th>
                      <th className="px-3 py-2 text-right">涨跌</th>
                      <th className="px-3 py-2 text-center">结果</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {tracking.signals.map((s, i) => (
                      <tr key={`${s.id}-${i}`} className="hover:bg-surface2/50">
                        <td className="px-3 py-2 tabular-nums text-muted">{s.code}</td>
                        <td className="px-3 py-2">{s.name}</td>
                        <td className="px-3 py-2"><span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px]">{s.strategy}</span></td>
                        <td className="px-3 py-2 text-right tabular-nums">{s.buyPrice}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{s.prevClose ?? "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{s.nextClose ?? "—"}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-medium ${(s.chgPct ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                          {s.chgPct != null ? (s.chgPct >= 0 ? "+" : "") + s.chgPct + "%" : "—"}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {s.isWin ? <ArrowUpRight size={14} className="mx-auto text-up" /> : s.isWin === false ? <ArrowDownRight size={14} className="mx-auto text-down" /> : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsibleSection>
          ) : null}

          {hasSignals ? (
            <div className="flex flex-col gap-4">
              <SignalCards title="竞价审核后可执行" signals={reviewed} variant="reviewed" />
              <SignalCards title="收盘初筛候选" signals={candidates} variant="candidate" />
            </div>
          ) : (
            <div className="rounded border border-line bg-surface2 py-12 text-center text-sm text-muted">
              今天还没有信号。收盘后脚本自动运行，明天早上来看。
            </div>
          )}
        </div>
      </Panel>
    </Frame>
  );
}
