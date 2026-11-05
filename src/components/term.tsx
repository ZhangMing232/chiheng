/**
 * 这个文件是干什么的：
 * 术语悬停卡——页面上行话的「白话解释」就地弹出，不用翻文档。
 *
 * 你需要知道的：
 * - 解释唯一出处是 glossary.ts（GLOSARY 键类型收窄：写错 key typecheck 直接报）。
 * - 桌面悬停/键盘聚焦弹出；触屏点按切换（再点一下收起）。
 * - 虚线下划线是「这里可以看解释」的通用暗示，全站同一写法。
 * - 卡片不编数据：词条内容本身受 glossary.ts 的写法纪律约束。
 */

import { useState, type ReactNode } from "react";
import { GLOSSARY, type GlossaryKey } from "@/lib/ui/glossary";

export function Term({ k, children }: { k: GlossaryKey; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const entry = GLOSSARY[k];
  return (
    <span className="group relative inline-block">
      <button
        type="button"
        aria-label={`术语解释：${entry.what}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        // 虚线下划线 + 品牌点：可点开解释的暗示。按钮无默认样式，视觉由 span 承担。
        className="cursor-help border-b border-dashed border-brand/50 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
      >
        {children ?? k}
      </button>
      {/* 桌面：悬停/组内聚焦显示；触屏：点按 open 后无条件显示。 */}
      <span
        role="tooltip"
        className={
          "absolute bottom-full left-1/2 z-50 mb-1.5 w-72 -translate-x-1/2 rounded-lg border border-line bg-surface-2 p-3 text-left text-xs leading-relaxed shadow-pop " +
          (open ? "visible" : "invisible group-hover:visible group-focus-within:visible")
        }
      >
        <span className="block font-medium text-fg">{entry.what}</span>
        <span className="mt-1 block text-muted">{entry.so}</span>
        {/* 小箭头 */}
        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 border-b border-r border-line bg-surface-2" aria-hidden />
      </span>
    </span>
  );
}
