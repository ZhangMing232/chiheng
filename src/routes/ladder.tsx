/**
 * 连板天梯（对标连板网 /tianti.html）——3 日并排 + 晋级率 + 首板折叠 + 点击高亮 + 个股弹层。
 *
 * 交互逻辑（逆向连板网学到的）：
 * 1. 3 日并排（最新在左），横看一行即该板位 3 日演变。
 * 2. 晋级率：昨日 N 板今天晋级 N+1 板的比例。
 * 3. 点行 → 它这 3 天出现的位置一起高亮；点股名 → 弹个股弹层（K线/涨停史/题材/监管异动）。
 * 4. 首板默认折叠。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getLadder3Day, getLimitUpReasons, getStockDetail, type LadderRow, type StockDetailPayload } from "@/lib/market/quotes.functions";

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

/** 简易 K 线火花线：收盘价折线，跌红涨绿是 A 股习惯，这里用中性色，不预判。 */
function Spark({ data }: { data: { date: string; c: number }[] }) {
  if (data.length < 2) return <div className="text-xs text-muted">K线不足</div>;
  const min = Math.min(...data.map((d) => d.c));
  const max = Math.max(...data.map((d) => d.c));
  const span = max - min || 1;
  const pts = data
    .map((d, i) => `${(i / (data.length - 1)) * 200},${60 - ((d.c - min) / span) * 56}`)
    .join(" ");
  const last = data[data.length - 1].c;
  const first = data[0].c;
  const up = last >= first;
  return (
    <div>
      <svg viewBox="0 0 200 60" className="h-14 w-full" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{data[0].date.slice(5)}</span>
        <span className="num">{first.toFixed(2)} → {last.toFixed(2)}</span>
        <span>{data[data.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function StockModal({ detail, onClose }: { detail: StockDetailPayload; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-medium">{detail.name}</span>
            <span className="num text-xs text-muted">{detail.id}</span>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted hover:text-fg">✕</button>
        </div>
        {detail.concept ? (
          <div className="mb-2">
            <Tag tone="brand">{detail.concept}</Tag>
          </div>
        ) : null}
        <div className="mb-3">
          <div className="mb-1 text-[11px] text-muted">近 60 日收盘</div>
          <Spark data={detail.kline} />
        </div>
        {detail.limitUps.length > 0 ? (
          <div className="mb-3">
            <div className="mb-1 text-[11px] text-muted">近 10 次涨停</div>
            <div className="flex flex-wrap gap-1">
              {detail.limitUps.map((d) => (
                <span key={d} className="num rounded bg-up-soft px-1 text-[10px] text-up">{d.slice(5)}</span>
              ))}
            </div>
          </div>
        ) : null}
        {detail.regulatory ? (
          <div className="mb-2 rounded border border-line px-2 py-1.5 text-xs">
            <Tag tone={detail.regulatory.level === "已达" ? "warn" : "muted"}>
              {detail.regulatory.level === "已达" ? "已达异动线" : "临近异动线"}
            </Tag>
            <span className="num ml-2">
              3日偏离 {(detail.regulatory.dev * 100).toFixed(1)}% / {detail.regulatory.threshold.toFixed(0)}%
            </span>
          </div>
        ) : null}
        {detail.reason ? (
          <div className="border-t border-line pt-2 text-[11px] leading-relaxed text-muted">{detail.reason.slice(0, 200)}</div>
        ) : null}
      </div>
    </div>
  );
}

function LadderPage() {
  const { ladder, reasons } = Route.useLoaderData();
  const [expandFirst, setExpandFirst] = useState(false);
  const [hl, setHl] = useState<string | null>(null);
  const [detail, setDetail] = useState<StockDetailPayload | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const dates = [...ladder.dates].reverse();
  if (dates.length === 0) {
    return (
      <Frame wide>
        <Panel title="连板天梯"><StateBlock kind="empty" title="还没算" hint="ladder-3day.ts 跑一次就有。" /></Panel>
      </Frame>
    );
  }

  const levels = [...new Set(dates.flatMap((d) => Object.keys(ladder.ladder[d] ?? {})))].map(Number).sort((a, b) => b - a);
  const dayStats = (d: string) => {
    const lv = ladder.ladder[d] ?? {};
    return { total: Object.values(lv).reduce((n, arr) => n + arr.length, 0), top: Math.max(0, ...Object.keys(lv).map(Number)) };
  };

  const openDetail = async (id: string) => {
    setLoading(id);
    try {
      setDetail(await getStockDetail({ data: { id } }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <Frame wide>
      <div className="flex flex-col gap-3">
        <Panel title="三日板位演变" note={dates.join(" / ")}>
          <div className="px-3 py-2 text-[11px] text-muted">
            最新在左 · 横看一行即该板位 3 日演变 · 点股名弹 K 线/涨停史，点行高亮它在 3 天出现的位置
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
                  if (lv === 1 && !expandFirst) return null;
                  return (
                    <tr key={lv} className="border-b border-line align-top">
                      <td className="px-2 py-1.5 text-sm font-medium whitespace-nowrap">{lv === 1 ? "首板" : `${lv}板`}</td>
                      {dates.map((d) => {
                        const rows = ladder.ladder[d]?.[String(lv)] ?? [];
                        const promo = ladder.promotion[d]?.[String(lv)];
                        return (
                          <td key={d} className="px-2 py-1.5">
                            <div className="mb-0.5 text-[11px] text-muted">
                              共{rows.length}只{promo ? ` · ${lv}进${lv + 1} ${((promo.promoted / Math.max(1, promo.total)) * 100).toFixed(0)}%` : ""}
                            </div>
                            <div className="flex flex-col gap-0.5">
                              {rows.map((r) => {
                                const bare = r.id.replace(/^(sh|sz|bj)/, "");
                                const concept = reasons.reasons[bare]?.primary_concept ?? "";
                                const active = hl === r.id;
                                return (
                                  <div
                                    key={r.id}
                                    onClick={() => setHl((v) => (v === r.id ? null : r.id))}
                                    className={`flex cursor-pointer items-baseline gap-1 rounded px-1 text-[12px] ${active ? "bg-up-soft" : "hover:bg-surface-2"}`}
                                    title={reasons.reasons[bare]?.reason?.slice(0, 100) || undefined}
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); void openDetail(r.id); }}
                                      className={`truncate text-left hover:underline ${active ? "text-up" : "text-fg"}`}
                                    >
                                      {loading === r.id ? "…" : r.name}
                                    </button>
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
            晋级率 = 昨日该档晋级到下一板的比例（历史频率，不是预测）。涨停家数→次日 +0.4%~0.77%（已验证），追高连板 −3.71%（已证伪）。
          </div>
        </Panel>
      </div>
      {detail ? <StockModal detail={detail} onClose={() => setDetail(null)} /> : null}
    </Frame>
  );
}
