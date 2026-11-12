/**
 * 像素摘要带（2026-11-12）。
 *
 * 每个工作台顶部都该有四五个「先看这几个数」的格子，而不是一上来就是表格。
 * 抽成组件：一处定义等宽大数字、色阶、四角标，各页只传数据。
 *
 * 口径纪律：`value` 为 null 时显示「—」，不填 0——「没数据」和「是 0」是两件事。
 */
export type PixelStat = {
  label: string;
  /** 数字或短文本；null = 没有数据，会显示 — */
  value: string | number | null;
  /** up/down/brand/muted 决定颜色；默认跟随前景色 */
  tone?: "up" | "down" | "brand" | "muted" | "warn";
  /** 数字下面那行小字，解释这个数怎么算的 */
  hint?: string;
  /** 大字号（默认给最重要的 1-2 格） */
  hero?: boolean;
};

const TONE: Record<string, string> = {
  up: "text-up",
  down: "text-down",
  brand: "text-brand",
  muted: "text-muted",
  warn: "text-warn",
};

export function PixelSummary({
  label,
  stats,
  note,
}: {
  /** 斜切标签，惯例英文大写，比如 MY // WATCHLIST */
  label: string;
  stats: PixelStat[];
  /** 右侧一句口径说明 */
  note?: React.ReactNode;
}) {
  if (stats.length === 0) return null;
  return (
    <div className="px-mod4 border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="px-num text-[12px] tracking-widest text-brand">{label}</span>
        {note ? <span className="px-num text-[12px] text-muted">{note}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-2">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <div className="px-num text-[12px] tracking-wider text-muted">{s.label}</div>
            <div
              className={
                "px-num font-bold leading-none " +
                (s.hero ? "text-3xl " : "text-2xl ") +
                (s.tone ? TONE[s.tone] ?? "text-fg" : "text-fg")
              }
            >
              {s.value == null || s.value === "" ? "—" : s.value}
            </div>
            {s.hint ? <div className="px-num mt-0.5 text-[12px] text-muted">{s.hint}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
