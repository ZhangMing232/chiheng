/**
 * 这个文件是干什么的：
 * 来源行（U2+U4）与缺口块（U3）两个小组件，落实 UI-STANDARD v1.1 第 7 节。
 *
 * 你需要知道的：
 * 学 Vibe-Research 的卡片底部写法——数据从哪来必须说清三件套：
 * 取数时间（带时区）、是不是缓存、来源原名。示例话术出自它的每日复盘页
 * 「取于 12:30（北京时间），用的是缓存」。
 *
 * 「重新取」是旁路按钮：平时不用点，title 必须写明什么时候该绕过缓存。
 * 缺口块（GapList）是「部分缺口」的样式：主数据到了、个别字段缺，
 * 显式列出来，不拿 0 或 ✗ 凑（与「缺数据的样子就是缺」同源）。
 *
 * 视觉规范照 state-block.tsx：语义 token、不引第三方图标库、文字即按钮。
 */

/** 来源行三件套：取数时间 / 是否缓存 / 来源原名。字段给 null 就显示「—」，不编造。 */
export function SourceLine({
  at,
  cached,
  origin,
  onRefresh,
  refreshTitle,
  refreshBusy = false,
}: {
  /** 取数时间，已经格式化好的字符串（带时区），如「2026-10-12 09:35（北京时间）」 */
  at: string | null;
  /** 这次渲染用的是不是缓存；null = 不知道，显示「—」 */
  cached: boolean | null;
  /** 来源原名，原样显示（接口截断/改写的字段名不替用户「修正」） */
  origin: string | null;
  /** 给了就渲染「重新取」旁路按钮 */
  onRefresh?: () => void;
  /** 什么时候该绕过缓存，写具体（例：「今天的涨停池不用缓存」） */
  refreshTitle?: string;
  refreshBusy?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] leading-5 text-muted">
      <p>
        取于 {at ?? "—"} · {cached == null ? "是否缓存未知" : cached ? "用的是缓存" : "实时取数"} · 来源：{origin ?? "—"}
      </p>
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshBusy}
          title={refreshTitle ?? "重新取数"}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {refreshBusy ? "正在取…" : "重新取"}
        </button>
      ) : null}
    </div>
  );
}

/** 「没取到的」缺口块：主数据到了但个别字段缺，显式列出。空数组不渲染。 */
export function GapList({ items, title = "没取到的" }: { items: string[]; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 border-t border-line pt-2">
      <h4 className="mb-1 text-xs font-semibold">{title}</h4>
      <ul className="space-y-0.5 text-xs leading-5 text-muted">
        {items.map((g) => (
          <li key={g}>· {g}</li>
        ))}
      </ul>
    </div>
  );
}
