/**
 * 连板天梯（对标连板网 /tianti.html）——3 日并排 + 晋级率 + 首板折叠 + 点击高亮。
 *
 * 交互逻辑（逆向连板网 JS 学到的）：
 * 1. 3 日并排（最新在左），横看一行即是该板位的 3 日演变。
 * 2. 晋级率：昨日 N 板今天晋级 N+1 板的比例（接力健康度）。
 * 3. 点任一只票 → 它在这 3 天出现的所有位置一起高亮（看晋级/断板）。
 * 4. 首板默认折叠（首板几十只，接力只发生在 2 板以上）。
 * 5. 每只票：封单额(万)·开板次数·题材（今日有封单，历史日只有名称）。
 *
 * 数据：ladder-3day.ts 从 K 线缓存算（不依赖归档）。
 */

import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getLadder3Day, getLimitUpReasons, type LadderRow } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/ladder")({
  loader: async () => {
    const [ladder, reasons] = await Promise.all([
      getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} as Record<string, Record<string, { total: number; promoted: number }>> })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {} as Record<string, { reason: string; primary_concept: string }>, sectors: {} })),
    ]);
    return { ladder, reasons };
  },
  component: LadderPage,
});

const fmt = (n: number) => `${(n / 10000).toFixed(0)}万`;

function LadderPage() {
  const { ladder, reasons } = Route.useLoaderData();
  const [expandFirst, setExpandFirst] = useState(false);
  const [hl, setHl] = useState<string | null>(null);

  const dates = [...ladder.dates].reverse(); // 最新在左（对标连板网）
  if (dates.length === 0) {
    return (
      <Frame wide aside="连板天梯">
        <Panel title="连板天梯">
          <StateBlock kind="empty" title="还没算" hint="ladder-3day.ts 从 K 线算，跑一次就有。" />
        </Panel>
      </Frame>
    );
  }

  // 所有出现的板位（从高到低）
  const levels = [...new Set(dates.flatMap((d) => Object.keys(ladder.ladder[d] ?? {})))]
    .map(Number)
    .sort((a, b) => b - a);

  const dayStats = (d: string) => {
    const lv = ladder.ladder[d] ?? {};
    const total = Object.values(lv).reduce((n, arr) => n + arr.length, 0);
    const top = Math.max(0, ...Object.keys(lv).map(Number));
    return { total, top };
  };

  return (
    <Frame wide aside="连板天梯">
      <div className="flex flex-col gap-3">
        <Panel title="连板天梯" note={dates.join(" / ")}>
          <div className="px-3 py-2 text-[11px] text-muted">
            最新在左 · 横着看一行即是该板位的 3 日演变 · 点任一只票，它在这 3 天出现的位置会一起高亮
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-2 py-1.5 text-left text-xs text-muted">板位</th>
                  {dates.map((d) => {
                    const s = dayStats(d);
                    return (
                      <th key={d} className="px-2 py-1.5 text-left text-xs">
                        <div className="font-medium">{d.slice(5)}</div>
                        <div className="font-normal text-muted">涨停{s.total} · 最高{s.top}板</div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {levels.map((lv) => {
                  const isFirst = lv === 1;
                  if (isFirst && !expandFirst) return null;
                  return (
                    <tr key={lv} className="border-b border-line align-top">
                      <td className="px-2 py-1.5 text-sm font-medium whitespace-nowrap">{lv === 1 ? "首板" : `${lv}板`}</td>
                      {dates.map((d) => {
                        const rows = ladder.ladder[d]?.[String(lv)] ?? [];
                        const promo = ladder.promotion[d]?.[String(lv)];
                        return (
                          <td key={d} className="px-2 py-1.5">
                            <div className="mb-0.5 text-[11px] text-muted">
                              共{rows.length}只
                              {promo ? ` · ${lv}进${lv + 1} ${((promo.promoted / Math.max(1, promo.total)) * 100).toFixed(0)}%` : ""}
                            </div>
                            <div className="flex flex-col gap-0.5">
                              {rows.map((r) => {
                                const concept = reasons.reasons[r.id]?.primary_concept ?? "";
                                const active = hl === r.id;
                                return (
                                  <div
                                    key={r.id}
                                    onClick={() => setHl((v) => (v === r.id ? null : r.id))}
                                    className={`flex cursor-pointer items-baseline gap-1 rounded px-1 text-[12px] ${active ? "bg-up-soft" : "hover:bg-surface-2"}`}
                                    title={reasons.reasons[r.id]?.reason?.slice(0, 100) || undefined}
                                  >
                                    <Link
                                      to="/research"
                                      search={{ q: r.id }}
                                      className={`truncate no-underline ${active ? "text-up" : "text-fg"}`}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      {r.name}
                                    </Link>
                                    {r.seal ? <span className="num shrink-0 text-[10px] text-muted">{fmt(r.seal)}·开板{r.breaks ?? 0}</span> : null}
                                    {concept ? <span className="shrink-0 text-[10px] text-brand-text">{concept}</span> : null}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-3 py-2">
            <button type="button" onClick={() => setExpandFirst((v) => !v)} className="text-xs text-muted hover:text-fg">
              {expandFirst ? "收起首板名单 ▴" : "展开首板名单 ▾"}
            </button>
          </div>
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            晋级率 = 昨日该档晋级到下一板的比例（历史频率，不是预测）。涨停家数→次日 +0.4%~0.77%（已验证），但追高连板 −3.71%（已证伪）。只做 2 板以上接力，首板默认折叠。
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
