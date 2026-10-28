/**
 * 战绩跟踪：信号次日涨跌历史表格。
 * 从 /arena 拆出来的子页面。
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { SectionTabs } from "@/components/section-tabs";
import { getSignalTracking } from "@/lib/market/quotes.functions";
import type { SignalTrackItem } from "@/lib/market/quotes.functions";
import { Trophy, ArrowUpRight, ArrowDownRight } from "lucide-react";

export const ARANA_TABS = [
  { to: "/arena/signals", label: "每日信号" },
  { to: "/arena/strategies", label: "策略管理" },
  { to: "/arena/tracking", label: "战绩跟踪" },
];

function ArenaTracking() {
  const { data } = useQuery({ queryKey: ["signalTracking"], queryFn: async () => await getSignalTracking(), refetchInterval: 300000 });
  const summary = data?.summary;
  const signals: SignalTrackItem[] = data?.signals ?? [];

  return (
    <Frame aside="策略竞技场">
      <Panel title="战绩跟踪" note="信号次日涨跌的完整记录。">
        <div className="flex flex-col gap-4 px-4 py-3">
          <SectionTabs tabs={ARANA_TABS} ariaLabel="竞技场子页面" />

          {!summary || signals.length === 0 ? (
            <div className="rounded border border-line bg-surface2 py-12 text-center text-sm text-muted">
              还没有跟踪数据。信号生成后次日收盘自动跑，每天 15:10 更新。
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* 汇总卡片 */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-line bg-surface2 px-4 py-3">
                <span className="flex items-center gap-1.5 text-sm font-medium"><Trophy size={14} className="text-brand" /> 汇总</span>
                <span className="text-sm text-muted">信号日 {summary.signalDate} → 跟踪日 {summary.trackedDate}</span>
                <span className={`text-sm font-medium tabular-nums ${summary.winRate >= 50 ? "text-up" : "text-down"}`}>胜率 {summary.winRate}%</span>
                <span className="text-sm tabular-nums">{summary.wins}胜 {summary.losses}负</span>
                <span className="text-sm tabular-nums">盈亏比 {summary.plRatio}</span>
                <span className="text-sm text-muted">均赢 +{summary.avgWinPct}%</span>
                <span className="text-sm text-muted">均亏 {summary.avgLossPct}%</span>
              </div>

              {/* 策略分组汇总 */}
              <div className="flex flex-wrap gap-3">
                {Object.entries(summary.byStrategy).map(([name, v]) => (
                  <div key={name} className={`rounded border px-3 py-2 text-xs ${v.avgChg >= 0 ? "border-up/40 bg-up/5" : "border-down/40 bg-down/5"}`}>
                    <div className="font-medium text-sm">{name}</div>
                    <div className="text-muted tabular-nums">{v.count} 条 | {v.wins}胜{v.losses}负</div>
                    <div className={`tabular-nums ${v.avgChg >= 0 ? "text-up" : "text-down"}`}>均{v.avgChg >= 0 ? "+" : ""}{v.avgChg}%</div>
                  </div>
                ))}
              </div>

              {/* 明细表格 */}
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
                    {signals.map((s, i) => (
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
            </div>
          )}
        </div>
      </Panel>
    </Frame>
  );
}

export const Route = createFileRoute("/arena/tracking")({ component: ArenaTracking });