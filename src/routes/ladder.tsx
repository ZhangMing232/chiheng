/**
 * 连板天梯（对标连板网 /tianti.html 的单日版）——板位从高到低，首板折叠，悬停看原因。
 *
 * 交互逻辑（逆向连板网学到的，之前漏了）：
 * 1. 首板默认折叠：首板每天几十只，展开撑爆页面，接力只发生在 2 板以上；
 *    折叠的只是名单，「1进2」数字留在行头。
 * 2. 悬停一只票 → 浮出涨停原因（title 提示）。
 * 3. 每只票显示：封单额(万) · 开板次数 · 题材标签 · N天M板。
 *
 * 还没做（数据积累中）：3 日并排对比 + 晋级率（要 3 天归档）、接力高亮、
 * 反包行（要前日断板数据）。
 */

import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getMarketSnapshot } from "@/lib/market/limit-up.functions";
import { getLimitUpReasons } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/ladder")({
  loader: async () => {
    const [snap, reasons] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {} as Record<string, import("@/lib/market/quotes.functions").LimitUpReason>, sectors: {} })),
    ]);
    return { snap, reasons };
  },
  component: LadderPage,
});

function LadderPage() {
  const { snap, reasons } = Route.useLoaderData();
  const [expandFirst, setExpandFirst] = useState(false);
  const pool = snap.snapshot;
  const limitRows = pool?.limitUp ?? [];

  // 板位从高到低分组
  const groups = (() => {
    const m = new Map<number, typeof limitRows>();
    for (const r of limitRows) {
      const st = r.streak ?? 1;
      const arr = m.get(st) ?? [];
      arr.push(r);
      m.set(st, arr);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([streak, rows]) => ({ streak, rows }));
  })();

  const firstBoard = groups.find((g) => g.streak === 1);
  const highBoards = groups.filter((g) => g.streak >= 2);
  const firstCount = firstBoard?.rows.length ?? 0;

  const reasonText = (code: string) => {
    const r = reasons.reasons[code];
    return r?.reason ? r.reason.slice(0, 120) + (r.reason.length > 120 ? "…" : "") : "";
  };

  const renderRows = (rows: typeof limitRows) =>
    rows.map((r) => {
      const concept = reasons.reasons[r.code]?.primary_concept ?? r.industry ?? "";
      const isPureStreak = r.stat === `${r.streak}天${r.streak}板`;
      return (
        <Link
          key={r.id}
          to="/research"
          search={{ q: r.code }}
          title={reasonText(r.code) || undefined}
          className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
        >
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium">{r.name}</span>
            {r.stat && !isPureStreak ? (
              <span className="num shrink-0 rounded bg-surface2 px-1 text-[10px] text-warn">{r.stat}</span>
            ) : null}
          </span>
          <span className="num shrink-0 text-[11px] text-muted">
            {r.sealFund ? `${(r.sealFund / 10000).toFixed(0)}万` : "—"} · 开板{r.breaks ?? 0}
          </span>
          {concept ? (
            <span className="shrink-0 rounded bg-brand-soft px-1 text-[10px] text-brand-text">{concept}</span>
          ) : null}
        </Link>
      );
    });

  return (
    <Frame wide aside="连板天梯">
      <div className="flex flex-col gap-3">
        <Panel title="连板天梯" note={pool ? `${pool.date} ${pool.sealed ? "收盘后" : "盘中未定"}` : "今天还没采集"}>
          {!pool ? (
            <StateBlock kind="empty" title="今天还没采集" hint="capture-market-snapshot.ts 收盘后 15:12 跑。" />
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {highBoards.map((g) => (
                <div key={g.streak} className="rounded border border-line bg-surface">
                  <div className="flex items-baseline justify-between border-b border-line px-3 py-1.5">
                    <span className="text-sm font-medium text-up">{g.streak} 板</span>
                    <span className="num text-xs text-muted">共 {g.rows.length} 只</span>
                  </div>
                  <div className="flex flex-col gap-0.5 p-1.5">{renderRows(g.rows)}</div>
                </div>
              ))}

              {/* 首板：默认折叠，只留「1进2」数字在行头（对标连板网） */}
              <div className="rounded border border-line bg-surface">
                <div className="flex items-baseline justify-between border-b border-line px-3 py-1.5">
                  <span className="text-sm font-medium">首板</span>
                  <span className="num text-xs text-muted">共 {firstCount} 只</span>
                </div>
                {expandFirst ? (
                  <div className="flex flex-col gap-0.5 p-1.5">{firstBoard ? renderRows(firstBoard.rows) : null}</div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setExpandFirst((v) => !v)}
                  className="w-full px-3 py-1.5 text-left text-xs text-muted hover:text-fg"
                >
                  {expandFirst ? "收起首板名单 ▴" : `展开首板名单 ${firstCount} 只 ▾`}
                </button>
              </div>
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            悬停一只票看涨停原因，点股名看 K 线。接力只发生在 2 板以上，首板默认折叠。3 日并排对比 + 晋级率要 3 天归档，攒够自动上。
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
