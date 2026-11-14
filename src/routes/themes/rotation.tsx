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
import { SectionTabs, THEME_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getThemeRotation, getThemeHeat, getThemeMembers, type ThemeHeatItem, type ThemeMembersPayload } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/themes/rotation")({
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

/**
 * 统计标签板：不是题材，是行情软件按指标筛出来的名单。
 * 它们天天在榜（昨日高振幅/QFII 新进/东方财富热股/最近多板），涨停家数还很高，
 * 混进热力格会把真题材挤下去——用户看到的第一名会是「昨日高振幅」这种鬼东西。
 * 用保守的模式匹配，只挡明显的标签名，别误伤「预制菜概念」这类真题材。
 */
const TAG_BOARD = /^(昨日|最近多板)|QFII|东方财富热股|^高市净率$|^破发股$|^次新股$|^低价股$|中报|年报|季报|预告|首亏|扭亏|破增发价|破净/;

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
  const cleaned = rows.filter((r) => !NOISE.has(r.name) && !TAG_BOARD.test(r.name));
  const up = cleaned.filter((r) => r.rot === "加速").slice(0, 15);
  const down = cleaned.filter((r) => r.rot === "减速").slice(0, 8);
  const maxUp = Math.max(1, ...up.map((r) => r.limitUp));
  const maxDown = Math.max(1, ...down.map((r) => r.limitUp));

  return (
    <Frame wide decorHeader={false}>
      <SectionTabs ariaLabel="题材" tabs={THEME_TABS} />
      <PixelHeader label="THEMES // ROTATION" meta="涨停家数比昨天多才算扩散" />
      <div className="flex flex-col gap-3">
        {/* ── 热力格：一格 = 一只涨停（2026-11-12 按设计稿加）── */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="px-slash">HEAT_MAP</span>
          <span className="h-px flex-1 bg-line" />
          <span className="px-num text-[12px] text-muted">一格一只涨停 · 青色在扩散，品红在缩</span>
        </div>

        <div className="px-mod4 border border-line bg-surface px-4 py-3">
          {cleaned.length === 0 ? (
            <div className="py-2 text-[13px] text-muted">题材热度还没算。</div>
          ) : (
            [...cleaned]
              .sort((a, b) => b.limitUp - a.limitUp)
              .slice(0, 8)
              .map((r) => {
                const slow = r.rot === "减速";
                return (
                  <div key={r.name} className="flex items-center gap-3 border-b border-dashed border-line py-1.5 last:border-0">
                    <button
                      type="button"
                      onClick={() => void openMembers(r.name)}
                      className="w-32 shrink-0 truncate text-left text-[13px] hover:underline"
                    >
                      {r.name}
                    </button>
                    <span className="flex flex-wrap gap-[3px]">
                      {Array.from({ length: Math.min(24, r.limitUp) }).map((_, i) => (
                        <span key={i} className={"h-4 w-2.5 " + (slow ? "bg-warn" : "bg-brand")} />
                      ))}
                    </span>
                    <span className={"px-num ml-auto shrink-0 text-[13px] " + (slow ? "text-warn" : "text-fg")}>
                      {r.limitUp}
                    </span>
                    <span className="px-num w-14 shrink-0 text-right text-[12px] text-muted">{r.rot}</span>
                  </div>
                );
              })
          )}
        </div>

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
                      <div className="mt-0.5 flex items-baseline justify-between text-[12px] text-muted">
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
                      <div className="mt-0.5 flex items-baseline justify-between text-[12px] text-muted">
                        <span>5日{(r.chg5d * 100).toFixed(1)}%</span>
                        <span>龙头 {r.heat?.leader?.name ?? "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
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
            {members.total > 60 ? <div className="mt-2 text-[12px] text-muted">只显示前 60 只</div> : null}
          </div>
        </div>
      ) : null}
      <div className="px-mobile-bar">
        <div className="px-num text-[12px] text-muted">题材 · 在扩散 </div>
        <div className="px-num text-[12px] text-brand">看轮动 ▾</div>
      </div>

    </Frame>
  );
}
