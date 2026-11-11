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

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getThemeRotation } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/rotation")({
  loader: () => getThemeRotation().catch(() => ({ date: "", rows: [] })),
  component: RotationPage,
});

// 风格/资金标签，不是题材，过滤掉
const NOISE = new Set([
  "深股通", "沪股通", "融资融券", "基金减仓", "机构重仓", "连续亏损", "小盘股", "大盘股",
  "AH股", "上证380", "2026中报预减", "低价股", "高股息", "微盘股", "破净股",
]);

const rotTone = { 加速: "up", 减速: "down", 平稳: "muted" } as const;

function RotationPage() {
  const { date, rows } = Route.useLoaderData();
  const cleaned = rows.filter((r) => !NOISE.has(r.name));
  const up = cleaned.filter((r) => r.rot === "加速").slice(0, 15);
  const down = cleaned.filter((r) => r.rot === "减速").slice(0, 8);

  return (
    <Frame wide aside="题材轮动">
      <div className="flex flex-col gap-3">
        <Panel title="题材轮动" note={date ? `${date} · 涨停家数 vs 近5日均值` : "还没算"}>
          {cleaned.length === 0 ? (
            <StateBlock kind="empty" title="还没算" hint="theme-rotation.ts 收盘后跑。" />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="px-3 pt-2 text-xs text-muted">轮动进 · 加速（资金在进）</div>
                <div className="flex flex-col gap-1 p-2">
                  {up.map((r) => (
                    <div key={r.name} className="flex items-baseline justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface2">
                      <span className="flex items-baseline gap-1.5">
                        <Tag tone="up">加速</Tag>
                        <span className="truncate font-medium">{r.name}</span>
                      </span>
                      <span className="num shrink-0 text-xs text-muted">
                        {r.limitUp}涨停 · 均<span className={toneClass(r.avgChg)}>{(r.avgChg * 100).toFixed(1)}%</span> · 5日{(r.chg5d * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="px-3 pt-2 text-xs text-muted">轮动出 · 减速（资金在撤）</div>
                <div className="flex flex-col gap-1 p-2">
                  {down.map((r) => (
                    <div key={r.name} className="flex items-baseline justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface2">
                      <span className="flex items-baseline gap-1.5">
                        <Tag tone="down">减速</Tag>
                        <span className="truncate font-medium">{r.name}</span>
                      </span>
                      <span className="num shrink-0 text-xs text-muted">
                        {r.limitUp}涨停 · 5日{(r.chg5d * 100).toFixed(1)}%
                      </span>
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
    </Frame>
  );
}
