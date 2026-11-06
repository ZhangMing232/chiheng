/**
 * 这个文件是干什么的：
 * 一枚「可移除的筛选芯片」：一个标签 + 一个 × 关闭按钮。效果图上「板块 沪深主板 ×」
 * 那种带叉的 pill 就是它。选股页用它把当前激活的板块/股价/市值筛选项可视化出来，
 * 点 × 就把那一项复位成「不限」。
 *
 * 你需要知道的：
 * - 颜色只走 token（border-line / bg-surface-2 / text-fg / text-muted），不写死——
 *   深浅主题自动跟随，也绝不碰现有的青色配色（用户拍板不动颜色）。
 * - onRemove 给了就渲染 × 按钮；不给就是纯展示的只读芯片。
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";

export function FilterChip({
  label,
  onRemove,
  className = "",
}: {
  /** 芯片主文案。可以塞 JSX，比如「<span class="text-muted">板块</span> 沪深主板」。 */
  label: ReactNode;
  /** 给了就显示 × 按钮，点它触发复位。不给就是只读芯片。 */
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs text-fg ${className}`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="移除该筛选"
          className="-mr-1 grid size-4 shrink-0 place-items-center rounded-full text-muted transition hover:bg-line hover:text-fg"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
