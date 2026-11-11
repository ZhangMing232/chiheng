/**
 * 跟单板块（原 /strategies/signals 页的全部内容，2026-11-11 并进策略跟踪页）。
 *
 * 为什么并进来：策略追踪（持仓）和跟单信号（信号）是同一件事的两端——
 * 「信号来了买不买 → 买了拿着怎么样 → 历史信号准不准」是一条链。拆成两个 tab
 * 用户得来回跳。这里统一成「跟单」子 tab，按工作流顺序排：
 *
 *   今日信号（可执行） → 战绩跟踪（过去信号准不准） → 观察（短线形态台账）
 *
 * 数据由宿主页（positions.tsx）的 loader 一并拉好传进来，本组件不自己取数。
 */

import { CheckCircle, AlertTriangle, Zap, Trophy, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { CollapsibleSection } from "@/components/collapsible";
import type { SignalCandidate, SignalReviewed, SignalTrackItem, SignalTrackSummary, ShortFormsData } from "@/lib/market/quotes.functions";

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

/** 短线形态台账：每天收盘后攒证据，只作观察，不给买卖建议。 */
function ShortFormsBoard({ data }: { data: ShortFormsData | null }) {
  if (!data) return null;
  if (data.unavailable) {
    return <div className="rounded border border-line bg-surface2 px-4 py-3 text-xs text-muted">{data.unavailable}</div>;
  }
  const cov = data.coverage;
  const stale = cov != null && cov.stale > cov.usableFiles * 0.1;
  const rows = Object.entries(data.forms);
  const latestCount = Object.values(data.latest).reduce((n, list) => n + list.length, 0);
  const num = (v: number | null, suffix = "", signed = true) =>
    v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v}${suffix}`;
  const tone = (v: number | null) => (v == null ? "text-muted" : v >= 0 ? "text-up" : "text-down");

  return (
    <CollapsibleSection
      storageKey="ch-collapse-short-forms"
      defaultOpen={false}
      header={
        <>
          <h2 className="text-sm font-medium">短线形态台账 · {data.date ?? "日期未知"}</h2>
          <p className="text-xs text-muted">{data.source || "来源未标注"} · 只作观察，不给买卖建议</p>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {stale && (
          <div className="flex items-start gap-2 rounded border border-line bg-surface2 px-3 py-2 text-xs text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>当日名单只覆盖 {cov!.atDate} 只，另有 {cov!.stale} 只 K 线滞后。这不是全池快照，别照着下单。</span>
          </div>
        )}
        <div className="overflow-hidden rounded border border-line">
          <table className="data-table w-full text-xs">
            <thead className="bg-surface2 text-left text-muted">
              <tr>
                <th className="px-3 py-2">形态</th>
                <th className="px-3 py-2 text-right">样本</th>
                <th className="px-3 py-2 text-right">能买到</th>
                <th className="px-3 py-2 text-right">次日</th>
                <th className="px-3 py-2 text-right">持 2 日</th>
                <th className="px-3 py-2 text-right">次日胜率</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(([name, s]) => (
                <tr key={name} className="hover:bg-surface2/50">
                  <td className="px-3 py-2 font-medium">{name}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{s.samples}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(s.fillRate, "%", false)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${tone(s.avgR1)}`}>{num(s.avgR1, "%")}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${tone(s.avgR2)}`}>{num(s.avgR2, "%")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{num(s.winR1, "%", false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-muted">
          当日名单 {latestCount} 条
          {cov?.tdxLatestDate ? ` · 盘后包 ${cov.tdxLatestDate}（${cov.tdxRows} 只）` : " · 盘后包暂无"}
          {" · "}历史统计截至 {cov?.targetDate ?? "—"}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          {data.caveats[0] ?? ""} {data.caveats[1] ?? ""} 完整口径见 data/signals/forms/summary.json。
        </p>
      </div>
    </CollapsibleSection>
  );
}

export type SignalBoardData = {
  candidates: SignalCandidate[];
  reviewed: SignalReviewed[];
  tracking: { signalDate: string; trackedDate: string; summary: SignalTrackSummary | null; signals: SignalTrackItem[] } | null;
  forms: ShortFormsData | null;
};

/** 「跟单」子 tab 的完整内容：今日信号 → 战绩 → 观察。 */
export function SignalFollowBoard({ data }: { data: SignalBoardData }) {
  const { candidates, reviewed, tracking, forms } = data;
  const hasSignals = candidates.length > 0 || reviewed.length > 0;

  return (
    <div className="flex flex-col gap-4 px-1 py-1">
      {/* 1. 今日信号：最该看的放最上 */}
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

      {/* 2. 战绩：过去的信号准不准 */}
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

      {/* 3. 观察：短线形态台账（只作观察，放最后） */}
      <ShortFormsBoard data={forms} />
    </div>
  );
}
