/**
 * 这个文件是干什么的：
 * 按 `?` 弹出的快捷键面板——一张只读的键位表。
 *
 * 你需要知道的：
 * 1. **键位表和实际注册共用 `HOTKEYS` 这一份**（在 `hotkeys.tsx`）。面板不自己写一份文案，
 *    否则文档会和实现漂——「文档说有这个键，代码里没有」是最难查的一类不一致。
 * 2. **不用 vaul / radix Dialog**：一个只读的静态表，不值得引入焦点陷阱和滚动锁。
 *    但**必须用 createPortal 挂 body**：父级如果有 `overflow-hidden` 或 `transform`，
 *    固定定位的面板会被裁掉或变成相对定位（`data-status.tsx` 里记着这两条理由）。
 * 3. Esc 关、点遮罩关。`?` 再按一次也关（由 Provider 的开关逻辑管）。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HOTKEYS } from "@/lib/ui/hotkeys";

function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function ShortcutPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 跟 detail.tsx / data-status.tsx 同一个坑：portal 只能在浏览器里建
  if (!mounted || !open) return null;

  const groups = new Map<string, typeof HOTKEYS>();
  for (const item of HOTKEYS) {
    const list = groups.get(item.group) ?? [];
    list.push(item);
    groups.set(item.group, list);
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="快捷键">
      <button type="button" aria-label="关闭" className="absolute inset-0 cursor-default bg-fg/40" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
        <header className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-medium">快捷键</h2>
          <span className="text-xs text-muted">按 Esc 或 ? 关闭</span>
        </header>
        <div className="max-h-[70vh] overflow-auto px-4 py-3">
          {[...groups.entries()].map(([group, items]) => (
            <div key={group} className="mb-4 last:mb-0">
              <div className="mb-1.5 text-[11px] tracking-wide text-muted">{group}</div>
              <dl className="grid gap-1.5">
                {items.map((item) => (
                  <div key={item.keys.join("+")} className="flex items-baseline gap-3">
                    <dt className="flex w-20 shrink-0 items-center gap-1">
                      {item.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dt>
                    <dd className="min-w-0 flex-1">
                      <span className="text-xs text-fg">{item.label}</span>
                      <span className="ml-2 text-[11px] text-muted">{item.desc}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}