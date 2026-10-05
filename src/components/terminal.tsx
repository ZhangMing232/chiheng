/**
 * 这个文件是干什么的：
 * 盯盘界面的几块通用零件：横条行情、扁平卡片、区块标题、数字。
 * 选股页、消息页、持仓页都用它们，这样三个页面的层级和密度是一个调子。
 *
 * 你需要知道的：
 * 版式参考财联社和同花顺的盯盘页，取的是它们共同的三点：
 *
 * 1. **行情是一条横带，不是一堆卡片。** 指数横着排、一眼扫完，涨跌色直接上色。
 * 2. **层次靠分隔线，不靠阴影。** 卡片是扁的（4px 圆角）、边框 1px；
 *    同一页里只有「正在动的东西」才给阴影。
 * 3. **数字密而不乱。** 全部等宽（tabular-nums），小数点对齐；
 *    颜色只表达涨跌，不表达好坏——红涨绿跌是这个项目的既有约定，别改。
 *
 * 颜色一律走 tokens（--color-up / --color-down / --color-warn / --color-line …），
 * 不要在组件里写死色值，否则深浅色两套主题会对不上。
 */
import type { ReactNode } from "react";

/** 涨跌幅 → 文字颜色。A 股约定：红涨绿跌。 */
export function pctClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "text-muted";
  return value > 0 ? "text-up" : "text-down";
}

/** 一块扁平面板。盯盘页的基本容器。 */
export function Panel({
  title,
  note,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`overflow-hidden rounded border border-line bg-surface ${className}`}>
      {title ? (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          <div className="flex items-baseline gap-2 text-xs text-muted">
            {note}
            {action}
          </div>
        </header>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/**
 * 横条行情。指数、板块、持仓概览都用它。
 *
 * 财联社那种一眼扫完的排法：一格一个标的，名称在上、价格和涨跌幅在同一行，
 * 涨跌幅用色块底（红底/绿底）而不是只有字色——余光扫过去就能分出红绿。
 */
export function Tape({
  items,
  className = "",
}: {
  items: { id: string; name: string; price: number | null; pct: number | null; extra?: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={`flex overflow-x-auto scroll-slim ${className}`}>
      {items.map((item) => (
        <div
          key={item.id}
          className="flex min-w-[7.5rem] shrink-0 flex-col gap-0.5 border-r border-line px-3 py-1.5 last:border-r-0"
        >
          <span className="truncate text-xs text-muted">{item.name}</span>
          <span className="flex items-baseline gap-1.5">
            <span className="text-sm font-medium tabular-nums text-fg">
              {item.price == null ? "—" : item.price.toFixed(2)}
            </span>
            {/* 涨跌幅上色块：余光扫过去就能分出红绿，不用逐个数字去读 */}
            <span
              className={`rounded px-1 py-px text-xs font-medium tabular-nums ${
                item.pct == null || item.pct === 0
                  ? "bg-surface-2 text-muted"
                  : item.pct > 0
                    ? "bg-up-soft text-up"
                    : "bg-down-soft text-down"
              }`}
            >
              {item.pct == null ? "—" : `${item.pct > 0 ? "+" : ""}${item.pct.toFixed(2)}%`}
            </span>
          </span>
          {item.extra}
        </div>
      ))}
    </div>
  );
}

/**
 * 一个数字格子。盯盘页的统计条由它拼出来。
 *
 * label 在上、值在下——和页面其他地方一致，扫的时候值在同一水平线上。
 */
export function Stat({
  label,
  value,
  tone,
  hint,
  className = "",
}: {
  label: string;
  value: ReactNode;
  /** 传 pctClass 的结果；不给就是中性色 */
  tone?: string;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-3 py-2 ${className}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-base font-medium tabular-nums ${tone ?? "text-fg"}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/** 状态小标签。「持有 / T+1 / 止损 / 卖出」这类。 */
export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "up" | "down" | "warn" | "brand";
}) {
  const map = {
    muted: "bg-surface-2 text-muted",
    up: "bg-up-soft text-up",
    down: "bg-down-soft text-down",
    warn: "bg-warn-soft text-warn",
    brand: "bg-brand-soft text-brand",
  } as const;
  return <span className={`rounded px-1 py-px text-xs ${map[tone]}`}>{children}</span>;
}

/**
 * 表格外壳。盯盘页的表格都要横向滚（列多），滚动容器统一在这里，
 * 免得每处都写一遍 overflow-x-auto scroll-slim。
 */
export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto scroll-slim ${className}`}>
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function thClass(extra = ""): string {
  return `px-2.5 py-1.5 text-right text-xs font-normal text-muted ${extra}`;
}

export function tdClass(extra = ""): string {
  return `px-2.5 py-1.5 text-right tabular-nums ${extra}`;
}
