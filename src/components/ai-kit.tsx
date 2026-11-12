/**
 * 这个文件是干什么的：
 * AI 区（/ai、/butler）专用的小组件库：发光面板、AI 统计卡、迷你柱、健康环、
 * 进化流水线、Token 堆叠面积图。视觉语言来自 2026-11-06 的新效果图
 * （深底 + AI 青窄条纹点缀）。
 *
 * 你需要知道的：
 * - 这里只管画，**不查任何数据源、不写任何状态文案**——数字和标签全部由调用方
 *   喂真实值。效果图里的 Wind/聚宽/「健康 96 分」那类演示数字不能抄进来，
 *   项目铁律：数字必须有出处，编一个就是假数据。
 * - 颜色只准用 token（text-ai / border-ai-line / bg-ai-soft），不写死色值，
 *   深浅两套主题在 styles.css 里各有一份 AI 青的映射。
 */

import type { ReactNode } from "react";

/** AI 青描边 + 顶部内发光的面板：AI 页的 hero / 重点块专用。 */
export function GlowPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-lg border border-ai-line bg-surface ${className}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(90% 130% at 50% -30%, var(--color-ai-soft), transparent 70%)" }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/** 迷你柱状 sparkline：零值画 4% 的矮柱（柱子消失会被读成「没数据」）。 */
export function MiniBars({ values, className = "" }: { values: number[]; className?: string }) {
  const max = Math.max(...values, 1);
  return (
    <div aria-hidden className={`flex h-6 items-end gap-[2px] ${className}`}>
      {values.map((v, i) => (
        <div
          key={i}
          className="w-[3px] rounded-sm bg-ai/70"
          style={{ height: `${v > 0 ? Math.max((v / max) * 100, 12) : 5}%` }}
        />
      ))}
    </div>
  );
}

/** AI 统计卡：图标 + 标签 + 大数字 + 副行（差异/说明），可选迷你柱。 */
export function AiStat({
  icon,
  label,
  value,
  sub,
  bars,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  bars?: number[];
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3">
      {icon ? <span className="mt-0.5 shrink-0 text-ai">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted">{label}</div>
        <div className="mt-0.5 text-xl font-semibold tabular-nums text-fg">{value}</div>
        {sub ? <div className="mt-0.5 truncate text-[12px] text-muted">{sub}</div> : null}
      </div>
      {bars ? <MiniBars values={bars} className="mt-1 shrink-0" /> : null}
    </div>
  );
}

/** 健康环：0–100。分数由调用方按真实检查项算好，构成写进 title 提示。 */
export function HealthRing({ value, label = "系统健康", hint }: { value: number; label?: string; hint?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" title={hint}>
      <svg viewBox="0 0 120 120" width="128" height="128" role="img" aria-label={`${label} ${pct}/100`}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-line)" strokeWidth="7" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--color-ai)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-[10px] text-muted">{label}</div>
        <div className="text-[26px] font-semibold leading-tight tabular-nums text-ai">{pct}</div>
        <div className="text-[10px] text-muted">/100</div>
      </div>
    </div>
  );
}

/** 进化流水线的一个阶段。metric 是这一阶段的真实计数/时间，由调用方喂。 */
export type PipelineStage = {
  icon: ReactNode;
  step: string;
  title: string;
  desc: string;
  metric: ReactNode;
  done: boolean;
  /** 进行中（黄）优先于已完成（青）显示——mockup 语义：05 人工确认在等人。 */
  waiting?: boolean;
};

export function Pipeline({ stages }: { stages: PipelineStage[] }) {
  return (
    <div>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {stages.map((s, i) => (
          <li key={s.step} className="flex min-w-0 flex-1 items-stretch gap-1.5">
            <div
              className={
                "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center " +
                (s.waiting
                  ? "border-warn/50 bg-warn-soft"
                  : s.done
                    ? "border-ai-line bg-ai-soft"
                    : "border-line bg-surface")
              }
            >
              <span className={s.done || s.waiting ? "text-ai" : "text-muted"}>{s.icon}</span>
              <span className="text-[10px] tabular-nums text-muted">{s.step}</span>
              <span className="text-xs font-medium text-fg">{s.title}</span>
              <span className="text-[10px] leading-snug text-muted">{s.desc}</span>
              <span className="mt-auto pt-1 text-[10px] tabular-nums text-fg">{s.metric}</span>
            </div>
            {i < stages.length - 1 ? (
              <span aria-hidden className="self-center shrink-0 text-muted">
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Token 堆叠面积图（手绘 SVG，7~30 个点，不值得为此挂 echarts）。
 * series 按传入顺序自下而上堆叠；values 等长；labels 是 x 轴刻度。
 */
export function StackedArea({
  series,
  labels,
  height = 170,
}: {
  series: { name: string; values: number[] }[];
  labels: string[];
  height?: number;
}) {
  const W = 700;
  const H = height;
  const padB = 18;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * (W - 8) + 4);
  const y = (v: number) => H - padB - (v / max) * (H - padB - 8);
  // 自下而上累计
  const stacks: number[][] = [];
  let acc = labels.map(() => 0);
  for (const s of series) {
    acc = acc.map((a, i) => a + (s.values[i] ?? 0));
    stacks.push([...acc]);
  }
  const areaPath = (upper: number[], lower: number[]) =>
    upper.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") +
    " " +
    [...lower.keys()]
      .reverse()
      .map((i) => `L${x(i).toFixed(1)},${y(lower[i]).toFixed(1)}`)
      .join(" ") +
    " Z";
  const linePath = (vs: number[]) => vs.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaColors = ["var(--color-ai)", "var(--color-warn)", "var(--color-up)"];
  const lineColors = ["var(--color-ai)", "var(--color-warn)", "var(--color-up)"];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={"Token 用量趋势，" + series.map((s) => s.name).join("、")}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-line)" strokeWidth="1" />
        ))}
        {stacks.map((upper, si) => {
          const lower = si === 0 ? labels.map(() => 0) : stacks[si - 1];
          return (
            <g key={si}>
              <path d={areaPath(upper, lower)} fill={areaColors[si % 3]} opacity="0.28" />
              <path d={linePath(upper)} fill="none" stroke={lineColors[si % 3]} strokeWidth="1.5" />
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % Math.ceil(n / 8) === 0 || i === n - 1 ? (
            <text key={l + i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="10" fill="var(--color-muted)">
              {l}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        {series.map((s, i) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <i aria-hidden className="inline-block size-2 rounded-full" style={{ background: areaColors[i % 3] }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
