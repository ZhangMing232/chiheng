/**
 * 三日演变（/watch/history）——原「连板天梯 /ladder」，2026-11-11 晚并进盯盘区。
 *
 * 和 /watch/（今日梯队）的分工，以及这次去重到底去掉了什么：
 *   - 三日并排、晋级率、点股名弹 K 线/涨停史/监管异动 —— **这一页独有**，留。
 *   - 今天的封单额、开板次数、题材标签 —— **今日梯队那一页已经有**，这里不再列。
 *     所以今天那一列只列名字（看得出「这只票昨天 2 板今天 3 板」这条连续性），
 *     不带明细。同一批票的同一批数摆两遍，就是用户说的「只有名字不一样」。
 *
 * 交互逻辑（逆向连板网学到的）：
 * 1. 3 日并排（最新在左），横看一行即该板位 3 日演变。
 * 2. 晋级率：昨日 N 板今天晋级 N+1 板的比例。
 * 3. 点行 → 它这 3 天出现的位置一起高亮；点股名 → 弹个股弹层（K线/涨停史/监管异动）。
 * 4. 首板默认折叠。
 */

import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, WATCH_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getLadder3Day, getLimitUpReasons, getStockDetail, type LadderRow, type StockDetailPayload } from "@/lib/market/quotes.functions";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/watch/history")({
  loader: async () => {
    const [ladder, reasons] = await Promise.all([
      getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} as Record<string, Record<string, { total: number; promoted: number }>> })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {} as Record<string, { reason: string; primary_concept: string }>, sectors: {} })),
    ]);
    return { ladder, reasons };
  },
  component: WatchHistoryPage,
});

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
      <div className="flex justify-between text-[12px] text-muted">
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
          <div className="mb-1 text-[12px] text-muted">近 60 日收盘</div>
          <Spark data={detail.kline} />
        </div>
        {detail.limitUps.length > 0 ? (
          <div className="mb-3">
            <div className="mb-1 text-[12px] text-muted">近 10 次涨停</div>
            <div className="flex flex-wrap gap-1">
              {detail.limitUps.map((d) => (
                <span key={d} className="num rounded bg-up-soft px-1 text-[12px] text-up">{d.slice(5)}</span>
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
          <div className="border-t border-line pt-2 text-[12px] leading-relaxed text-muted">{detail.reason.slice(0, 200)}</div>
        ) : null}
      </div>
    </div>
  );
}

function WatchHistoryPage() {
  const { ladder, reasons } = Route.useLoaderData();
  const [expandFirst, setExpandFirst] = useState(false);
  const [hl, setHl] = useState<string | null>(null);
  const [detail, setDetail] = useState<StockDetailPayload | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const dates = [...ladder.dates].reverse();
  if (dates.length === 0) {
    return (
      <Frame wide>
        <SectionTabs ariaLabel="盯盘" tabs={WATCH_TABS} />
        <PixelHeader label="WATCH // 3-DAY" meta="三日演变 · 哪一档在加厚、哪一档在断档" />
        <Panel title="三日板位演变"><StateBlock kind="empty" title="还没算" hint="ladder-3day.ts 跑一次就有。" /></Panel>
      </Frame>
    );
  }

  // 最新那天（dates[0]）的明细在 /watch/ 上，这里只留名字与晋级率，不再列封单/开板/题材。
  const today = dates[0];

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
      <SectionTabs ariaLabel="盯盘" tabs={WATCH_TABS} />
      <PixelHeader label="WATCH // 3-DAY" meta="三日演变 · 哪一档在加厚、哪一档在断档" />
      <div className="flex flex-col gap-3">
        <Panel title="三日板位演变" note={dates.join(" / ")}>
          <div className="px-3 py-2 text-[12px] leading-relaxed text-muted">
            最新在左 · 横看一行即该板位 3 日演变 · 点股名弹 K 线/涨停史，点行高亮它在 3 天出现的位置。
            <span className="text-fg">今天那一列只列名字</span>——封单额、开板次数、题材标签在{" "}
            「今日梯队」页签，同一批数不摆两遍。
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="px-2 py-1.5 text-left text-xs text-muted">板位</th>
                  {dates.map((d) => {
                    const s = dayStats(d);
                    return (
                      <th key={d} className="px-2 py-1.5 text-left text-xs">
                        <div className="font-medium">{d.slice(5)}{d === today ? " · 今天" : ""}</div>
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
                        const isToday = d === today;
                        return (
                          <td key={d} className="px-2 py-1.5">
                            <div className="mb-0.5 text-[12px] text-muted">
                              共{rows.length}只{promo ? ` · ${lv}进${lv + 1} ${((promo.promoted / Math.max(1, promo.total)) * 100).toFixed(0)}%` : ""}
                            </div>
                            {/* 今天这列：紧凑名单（不带封单/开板/题材），明细在今日梯队 */}
                            <div className={isToday ? "flex flex-wrap gap-x-1.5 gap-y-0.5" : "flex flex-col gap-0.5"}>
                              {rows.map((r) => {
                                const bare = r.id.replace(/^(sh|sz|bj)/, "");
                                const concept = isToday ? "" : (reasons.reasons[bare]?.primary_concept ?? "");
                                const active = hl === r.id;
                                if (isToday) {
                                  return (
                                    <button
                                      key={r.id}
                                      type="button"
                                      onClick={() => setHl((v) => (v === r.id ? null : r.id))}
                                      className={`rounded px-1 text-[12px] leading-snug ${active ? "bg-up-soft text-up" : "text-fg hover:bg-surface-2"}`}
                                    >
                                      {r.name}
                                    </button>
                                  );
                                }
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
                                    {r.seal ? <span className="num shrink-0 text-[12px] text-muted">{(r.seal / 10000).toFixed(0)}万·开板{r.breaks ?? 0}</span> : null}
                                    {concept ? <span className="shrink-0 text-[12px] text-brand-text">{concept}</span> : null}
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
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            晋级率 = 昨日该档晋级到下一板的比例（历史频率，不是预测）。涨停家数→次日 +0.4%~0.77%（已验证），追高连板 −3.71%（已证伪）。
          </div>
        </Panel>
      </div>
      {detail ? <StockModal detail={detail} onClose={() => setDetail(null)} /> : null}
    </Frame>
  );
}
