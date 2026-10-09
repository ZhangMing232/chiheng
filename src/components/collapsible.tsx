/**
 * 这个文件是干什么的：
 * 可折叠区块。标题行左侧一个小箭头，点了收起/展开内容，状态记在 localStorage
 * 里——刷新、重开浏览器都保持。长页面（持仓页按天分组、因子页各区块）用它
 * 把不关心的部分折起来，不用在一屏长列表里翻来翻去。
 *
 * 你需要知道的：
 * 1. `storageKey` 必填且要全局唯一——撞 key 会把两个区块的折叠状态绑在一起。
 * 2. defaultOpen 只在**第一次**（localStorage 里没有记录）时生效，之后以
 *    用户点过的为准。用户的习惯比代码的猜测优先。
 * 3. 收起时内容不渲染（不是 display:none）——持仓页一天的明细几十行，
 *    折起来还挂 DOM 是白付渲染钱。
 * 4. header 的内容完全由调用方给（组件只管箭头 + 布局），所以各页自己的
 *    标题排版（如持仓页日期条右边的汇总数字）不用迁就组件。
 */
import { useState, type ReactNode } from "react";

export function CollapsibleSection({
  storageKey,
  header,
  defaultOpen = true,
  children,
  className = "",
  headerClassName = "",
}: {
  /** localStorage key，全局唯一，例如 "ch-collapse-pos-2026-10-09"。 */
  storageKey: string;
  /** 标题行内容（箭头之外的整行）。 */
  header: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch {
      // localStorage 不可用（隐私模式等）就当无状态组件用，不炸。
    }
    return defaultOpen;
  });
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // 存不进就算了，折叠功能降级为当次有效。
      }
      return next;
    });
  };
  return (
    <section className={`overflow-hidden rounded border border-line bg-surface ${className}`}>
      <header className={`flex items-baseline gap-2 px-3.5 py-2 ${headerClassName}`}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? "收起" : "展开"}
          className="shrink-0 rounded px-0.5 text-xs text-muted transition hover:bg-surface hover:text-fg"
        >
          <span aria-hidden>{open ? "▾" : "▸"}</span>
        </button>
        <div className="min-w-0 flex-1">{header}</div>
      </header>
      {open ? children : null}
    </section>
  );
}
