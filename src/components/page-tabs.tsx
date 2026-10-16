/**
 * 这个文件是干什么的：
 * 页内 tab（三级导航）的通用组件。2026-10-16 用户要求「不要一个页面向下滑」，
 * 日历页率先用搜索参数做了 tab（持仓到期 / 业绩预告），这个组件把同一模式
 * 固化下来给其余页面用。
 *
 * 你需要知道的：
 * - 选中状态可选持久化到 localStorage（storageKey），刷新保持；不给就只活在本次会话。
 * - tab 条语汇和日历页一致：圆角描边小按钮，选中项 border-brand。
 * - 只渲染选中 tab 的内容——七个区块全挂 DOM 的老做法废掉了（因子页教训）。
 */

import { useEffect, useState, type ReactNode } from "react";

export type PageTab = { key: string; label: string; content: ReactNode };

export function PageTabs({ tabs, storageKey, initial }: { tabs: PageTab[]; storageKey?: string; initial?: string }) {
  const [active, setActive] = useState<string>(initial ?? tabs[0]?.key ?? "");
  // 挂载后读一次本地存档（SSR 阶段没有 localStorage）
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && tabs.some((t) => t.key === saved)) setActive(saved);
    } catch {
      /* 读不到就用默认值 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function pick(key: string) {
    setActive(key);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, key);
      } catch {
        /* 存不进就算了 */
      }
    }
  }
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={current?.key === t.key}
            onClick={() => pick(t.key)}
            className={
              "rounded border px-2.5 py-1 text-xs transition " +
              (current?.key === t.key ? "border-brand font-medium text-fg" : "border-line text-muted hover:text-fg")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {current ? <div className="mt-3">{current.content}</div> : null}
    </div>
  );
}
