/**
 * 这个文件是干什么的：
 * 表格行右键菜单。在任意行的 onContextMenu 里调 open() 弹出，列出对这只股票能做的动作。
 *
 * 你需要知道的：
 * 轻量实现：fixed 定位在光标处，点击菜单外 / Esc / 滚动关闭。
 * 菜单项的回调里如果会触发页面跳转或状态变化，菜单先自己关掉，动作交给回调。
 * 纯 UI，不知道「看资金流向」去哪——菜单项由调用方传进来。
 */

import { useEffect, useRef, useState, type MouseEvent } from "react";

export type RowMenuItem = {
  label: string;
  onClick: () => void;
};

export type RowMenuState = {
  x: number;
  y: number;
  items: RowMenuItem[];
};

/** 从表格行的 onContextMenu 事件开菜单：e.preventDefault() 掉系统菜单，再 openFor(e, items)。 */
export function useRowMenu() {
  const [menu, setMenu] = useState<RowMenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      // 点在菜单外面才关；点在菜单项上让它先触发 click。
      const root = document.getElementById("row-menu");
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const openFor = (event: MouseEvent, items: RowMenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return { menu, openFor, close: () => setMenu(null) };
}

/** 菜单本体。挂在页面根部一次，所有表格行共用。 */
export function RowMenuPortal({ menu, onClose }: { menu: RowMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!menu) return null;
  // 贴边时往左/上收一点，别弹到视口外。
  const x = Math.min(menu.x, (window.innerWidth ?? 1200) - 180);
  const y = Math.min(menu.y, (window.innerHeight ?? 800) - menu.items.length * 36 - 16);
  return (
    <div
      id="row-menu"
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-40 rounded border border-line bg-surface-2 py-1 shadow-lg"
      style={{ left: x, top: y }}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="block w-full px-3 py-1.5 text-left text-sm text-fg hover:bg-brand-soft hover:text-brand-text"
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
