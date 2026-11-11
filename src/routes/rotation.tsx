/**
 * 这个文件是干什么的：
 * 「题材轮动」页——按题材动量 + 轮动方向排序（对标弈盘精选题材轮动，但自算零外部源）。
 *
 * 口径（已验证）：题材涨停家数 → 次日 +0.4%~0.77%（题材动量的硬 edge）。
 * 轮动 = 今日涨停家数 vs 近5日均涨停家数：加速（轮动进）/ 减速（轮动出）/ 平稳。
 *
 * 纪律：加速 ≠ 买入信号，是「题材在升温」的事实；追高连板已证伪（−3.71%），
 * 轮动进只说明资金在进，怎么跟要看龙头与情绪。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getThemeRotation, getThemeHeat, getThemeMembers, type ThemeHeatItem, type ThemeMembersPayload } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/rotation")({
  loader: async () => {
    const [rot, th] = await Promise.all([
      getThemeRotation().catch(() => ({ date: "", rows: [] })),
      getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
    ]);
    return { rot, th };
  },
  component: RotationPage,
});

// 风格/资金标签，不是题材，过滤掉
const NOISE = new Set([
  "深股通", "沪股通", "融资融券", "基金减仓", "机构重仓", "连续亏损", "小盘股", "大盘股",
  "AH股", "上证380", "2026中报预减", "低价股", "高股息", "微盘股", "破净股",
]);

const rotTone = { 加速: "up", 减速: "down", 平稳: "muted" } as const;

function RotationPage() {
  const { rot, th } = Route.useLoaderData();
  const date = rot.date || th.date;
  // 合并：题材（涨停/龙头来自 theme-heat，轮动方向/5日来自 theme-rotation）
  const [members, setMembers] = useState<ThemeMembersPayload | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const openMembers = async (name: string) => {
    setLoading(name);
    try {
      setMembers(await getThemeMembers({ data: { name } }));
    } finally {
      setLoading(null);
    }
  };
  const heatByName = new Map(th.hot.map((h) => [h.name, h]));
  const rows = rot.rows.map((r) => ({ ...r, heat: heatByName.get(r.name) ?? null }));
  const cleaned = rows.filter((r) => !NOISE.has(r.name));
  const up = cleaned.filter((r) => r.rot === "加速").slice(0, 15);
  const down = cleaned.filter((r) => r.rot === "减速").slice(0, 8);
  const maxUp = Math.max(1, ...up.map((r) => r.limitUp));
  const maxDown = Math.max(1, ...down.map((r) => r.limitUp));

  return (
    <Frame wide>
      <div className="flex flex-col gap-3">
        <Panel title="轮动方向" note={date ? `${date} · 涨停家数 vs 近5日均值` : "还没算"}>
          {cleaned.length === 0 ? (
            <StateBlock kind="empty" title="还没算" hint="theme-rotation.ts 收盘后跑。" />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="px-3 pt-2 text-xs text-muted">轮动进 · 加速（资金在进）</div>
                <div className="flex flex-col gap-1 p-2">
                  {up.map((r) => (
                    <div key={r.name} onClick={() => void openMembers(r.name)} className="cursor-pointer rounded px-2 py-1.5 hover:bg-surface2">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <Tag tone="up">加速</Tag>
                          <span className="truncate font-medium">{r.name}</span>
                        </span>
                        <span className="num shrink-0 text-xs text-up">{r.limitUp} 涨停</span>
                      </div>
                      <span className="mt-1 block h-1.5 rounded bg-surface2">
                        <span className="block h-1.5 rounded bg-up" style={{ width: `${(r.limitUp / maxUp) * 100}%` }} />
                      </span>
                      <div className="mt-0.5 flex items-baseline justify-between text-[10px] text-muted">
                        <span>均<span className={toneClass(r.avgChg)}>{(r.avgChg * 100).toFixed(1)}%</span> · 5日{(r.chg5d * 100).toFixed(1)}%</span>
                        <span>龙头 {r.heat?.leader?.name ?? "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="px-3 pt-2 text-xs text-muted">轮动出 · 减速（资金在撤）</div>
                <div className="flex flex-col gap-1 p-2">
                  {down.map((r) => (
                    <div key={r.name} onClick={() => void openMembers(r.name)} className="cursor-pointer rounded px-2 py-1.5 hover:bg-surface2">
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <Tag tone="down">减速</Tag>
                          <span className="truncate font-medium">{r.name}</span>
                        </span>
                        <span className="num shrink-0 text-xs text-down">{r.limitUp} 涨停</span>
                      </div>
                      <span className="mt-1 block h-1.5 rounded bg-surface2">
                        <span className="block h-1.5 rounded bg-down" style={{ width: `${(r.limitUp / maxDown) * 100}%` }} />
                      </span>
                      <div className="mt-0.5 flex items-baseline justify-between text-[10px] text-muted">
                        <span>5日{(r.chg5d * 100).toFixed(1)}%</span>
                        <span>龙头 {r.heat?.leader?.name ?? "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            题材涨停家数 → 次日 +0.4%~0.77%（单调，已验证）；但追高连板 −3.71%（已证伪）。
            加速是「资金在进」的事实，不是买入信号。风格/资金标签（融资融券、小盘股等）已过滤。
          </div>
        </Panel>
      </div>
      {members ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMembers(null)}>
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-line bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-baseline justify-between">
              <div>
                <span className="text-base font-medium">{members.name}</span>
                <span className="ml-2 text-xs text-muted">共 {members.total} 只（按涨跌幅排）</span>
              </div>
              <button type="button" onClick={() => setMembers(null)} className="text-sm text-muted hover:text-fg">✕</button>
            </div>
            <div className="flex flex-col gap-0.5">
              {members.members.slice(0, 60).map((m) => (
                <div key={m.id} className="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-[12px] hover:bg-surface2">
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate">{m.name}</span>
                    {m.limitUp ? <Tag tone="up">涨停</Tag> : null}
                  </span>
                  <span className={"num shrink-0 " + ((m.chg ?? 0) >= 0 ? "text-up" : "text-down")}>
                    {(m.chg ?? 0) > 0 ? "+" : ""}{(m.chg ?? 0).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
            {members.total > 60 ? <div className="mt-2 text-[11px] text-muted">只显示前 60 只</div> : null}
          </div>
        </div>
      ) : null}
    </Frame>
  );
}
