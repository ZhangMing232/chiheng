/**
 * KPI 头版卡（效果图签名件）：图标圆 + 标签 + 大数字 + 副行。
 * 数字必须是真实计数——组件不查数据、不做合成，调用方喂什么显什么。
 */
import type { ReactNode } from "react";

export function HeroStat({
  icon,
  label,
  value,
  suffix,
  sub,
  tone,
  valueTone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  suffix?: string;
  sub: string;
  tone: "ok" | "warn" | "muted";
  /** 数字本身的颜色（红涨绿跌铁律）；不给就默认正文色。 */
  valueTone?: "up" | "down";
}) {
  const cls =
    tone === "ok" ? "text-down bg-down-soft" : tone === "warn" ? "text-warn bg-warn-soft" : "text-muted bg-surface-2";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${cls}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        <div className="flex items-baseline gap-1">
          <span className={`text-2xl font-semibold tabular-nums ${valueTone === "up" ? "text-up" : valueTone === "down" ? "text-down" : "text-fg"}`}>{value}</span>
          {suffix ? <span className="text-xs text-muted">{suffix}</span> : null}
        </div>
        <div className="truncate text-[11px] text-muted">{sub}</div>
      </div>
    </div>
  );
}

