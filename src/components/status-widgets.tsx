/**
 * 这个文件是干什么的：
 * 数据可信度三件套：StatusBadge（状态徽章）、FreshnessBar（新鲜度条）、
 * StatusCard（状态卡）。承接 5 态模型（lib/ui/app-status.ts）的视觉层，
 * 来源同 2026-11-06 外部参考实现，颜色与形状全部映射到本项目 token。
 *
 * 你需要知道的：
 * - FreshnessBar 的口径纪律（README 设计规则 §3）：一个动态数据块的头部
 *   至少给「状态 · 数据源 · 更新时间 · 延迟 · 重试」。模块级时间放模块附近，
 *   别全塞进底部状态栏。
 * - 颜色走既有语义（照抄 nav 的约定，不新造）：
 *   绿 down = 正常/通过，红 up = 断开/要处理，琥珀 warn = 延迟/待确认，
 *   冰蓝 accent = 加载中，灰 muted = 暂无数据。
 * - StatusCard 是四段结构（标题徽章 / 主值 / 详情 / 操作）——
 *   详情和操作都是可选的，没有就别塞占位。
 */

import type { ReactNode } from "react";
import { describeSnapshot, formatLatency, statusMeta, type StatusSnapshot } from "@/lib/ui/app-status";

/** tone → 项目 token 的映射（和 useSysStatus 的点色同一套约定）。 */
const TONE_CLS: Record<string, { fg: string; bg: string; border: string }> = {
  positive: { fg: "text-down", bg: "bg-down-soft", border: "border-down/40" },
  primary: { fg: "text-accent", bg: "bg-accent-soft", border: "border-accent/40" },
  warning: { fg: "text-warn", bg: "bg-warn-soft", border: "border-warn/50" },
  negative: { fg: "text-up", bg: "bg-up-soft", border: "border-up/50" },
  neutral: { fg: "text-muted", bg: "bg-surface-2", border: "border-line" },
};

export function StatusBadge({ snapshot, compact = false }: { snapshot: StatusSnapshot; compact?: boolean }) {
  const meta = statusMeta[snapshot.state];
  const cls = TONE_CLS[meta.tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${cls.border} ${cls.bg} ${cls.fg} ${
        compact ? "px-1.5 py-px text-[12px]" : "px-2 py-0.5 text-[12px]"
      }`}
      title={describeSnapshot(snapshot)}
    >
      <span aria-hidden className="leading-none">{meta.icon}</span>
      <span className="whitespace-nowrap">{snapshot.label}</span>
      {snapshot.latencySeconds != null && !compact ? <span className="tabular-nums opacity-80">{formatLatency(snapshot.latencySeconds)}</span> : null}
    </span>
  );
}

/**
 * 新鲜度条：一行放下「状态徽章 · 数据源 · 更新于 · 延迟 · 提示 · 重试」。
 * 放在数据模块标题行下方或内容区顶部；state 不是 healthy 时整条带上底色。
 */
export function FreshnessBar({ snapshot, onRetry, className = "" }: { snapshot: StatusSnapshot; onRetry?: () => void; className?: string }) {
  const meta = statusMeta[snapshot.state];
  const cls = TONE_CLS[meta.tone];
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded border ${cls.border} ${cls.bg} px-3 py-1.5 text-[12px] ${className}`} role="status" aria-label={describeSnapshot(snapshot)}>
      <span className="flex min-w-0 items-center gap-3">
        <StatusBadge snapshot={snapshot} />
        {snapshot.source ? <span className="text-muted">数据源：{snapshot.source}</span> : null}
        {snapshot.updatedAt ? <span className="tabular-nums text-muted">更新于 {snapshot.updatedAt}</span> : null}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {snapshot.message ? <span className={cls.fg}>{snapshot.message}</span> : null}
        {snapshot.canRetry && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-line bg-surface px-2 py-0.5 text-muted transition hover:text-fg"
          >
            重试
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** 状态卡：标题徽章 / 主值 / 详情 / 操作 四段。主值没有延迟就显示 label。 */
export function StatusCard({
  title,
  snapshot,
  detail,
  action,
}: {
  title: string;
  snapshot: StatusSnapshot;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  const cls = TONE_CLS[statusMeta[snapshot.state].tone];
  return (
    <section className={`rounded border ${cls.border} bg-surface px-3.5 py-3`} aria-label={title} title={describeSnapshot(snapshot)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg">{title}</span>
        <StatusBadge snapshot={snapshot} compact />
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-fg">
        {snapshot.latencySeconds != null ? formatLatency(snapshot.latencySeconds) : snapshot.label}
      </div>
      {detail ? <div className="mt-0.5 text-[12px] text-muted">{detail}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </section>
  );
}
