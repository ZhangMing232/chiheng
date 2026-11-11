/**
 * 这个文件是干什么的：
 * 「市场情报」页——新闻 → 题材 → 个股的传导链路（对标弈盘 hotspot 市场情报）。
 *
 * 数据源：fetch-market-intel.ts 采集弈盘 yipanai 的公开 /api/hotspot/* 接口，
 * 落盘 data/history/market-intel/<date>.json，本页只读。
 *
 * 纪律：
 * 1. 新闻解读是「新闻→题材→个股」的传导，重要度是 yipanai 的评分，不是赤轨算的。
 * 2. 受益个股是新闻匹配到的题材成分股，不是买卖建议；传导有不确定性（新闻没说清楚的）。
 * 3. 锁了的字段（每日精选等）没采，这里不显示。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getMarketIntel } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/intel")({
  loader: () => getMarketIntel().catch(() => ({ date: "", cards: [], annGroups: [], annTotal: 0 })),
  component: IntelPage,
});

function importanceTone(n: number): "warn" | "up" | "muted" {
  return n >= 80 ? "warn" : n >= 70 ? "up" : "muted";
}

function IntelPage() {
  const { date, cards, annGroups, annTotal } = Route.useLoaderData();

  return (
    <Frame wide aside="市场情报">
      <div className="flex flex-col gap-3">
        <Panel title="市场情报 · 新闻解读" note={date ? `${date} · 新闻→题材→个股传导` : "还没采集"}>
          {cards.length === 0 ? (
            <StateBlock kind="empty" title="今天还没情报" hint="fetch-market-intel.ts 收盘后采集，盘中先看快讯页。" />
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {cards.map((c) => (
                <div key={c.title} className="rounded border border-line bg-surface px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 text-sm font-medium leading-snug">{c.title}</div>
                    <Tag tone={importanceTone(c.importance)}>{c.importance}</Tag>
                  </div>
                  {c.theme ? (
                    <div className="mt-1.5 text-xs text-muted">
                      题材：<span className="text-fg">{c.theme}</span>
                    </div>
                  ) : null}
                  {c.benefits.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.benefits.map((b) => (
                        <span key={b} className="rounded bg-brand-soft px-1 py-px text-[11px] text-brand-text">{b}</span>
                      ))}
                    </div>
                  ) : null}
                  {c.stocks.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className="text-[11px] text-muted">受益个股：</span>
                      {c.stocks.map((s) => (
                        <span key={s} className="rounded bg-surface2 px-1 py-px text-[11px] text-fg">{s}</span>
                      ))}
                    </div>
                  ) : null}
                  {c.reason ? (
                    <div className="mt-1.5 border-t border-line pt-1.5 text-[11px] leading-relaxed text-muted">{c.reason}</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="公告分组" note={annTotal ? `近两日共 ${annTotal} 条` : undefined}>
          {annGroups.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted">公告分组还没采集。</div>
          ) : (
            <div className="flex flex-wrap gap-2 p-3">
              {annGroups.map((g) => (
                <div key={g.name} className="rounded border border-line bg-surface px-3 py-1.5 text-sm">
                  <span className="text-muted">{g.name}</span>
                  <span className="num ml-1.5 text-fg">{g.count}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] text-muted">
            新闻解读重要度与传导为 yipanai 的评分/匹配，非赤轨计算；受益个股是题材成分股，不是买卖建议。
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
