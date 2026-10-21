/**
 * 这个文件是干什么的：
 * 「一个页面、几个子页面」的二级 tab 条（2026-10-21 用户要求：相关页面合成一个，
 * 里面变子页面，不要侧栏一堆平级入口）。挂在整合后各子页面 Frame 内容的顶部。
 *
 * 你需要知道的：
 * - 用真实路由链接（Link），不是本地状态：每个子页面保留自己的 loader 和 URL，
 *   刷新、书签、手机分享都落在具体子页上。
 * - 激活态按当前路径前缀判：/strategies/positions 激活「策略追踪」。
 * - 语汇和 PageTabs（页内 tab）一致：圆角描边小按钮，选中项 border-brand。
 */

import { Link, useRouterState } from "@tanstack/react-router";

export type SectionTab = { to: string; label: string };

export function SectionTabs({ tabs, ariaLabel }: { tabs: SectionTab[]; ariaLabel?: string }) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        // 索引子页的地址是 "/review/"，落到 location 上是 "/review"——比较前把尾斜杠剥掉。
        const target = tab.to.replace(/\/+$/, "");
        const active = path === target || path.startsWith(target + "/");
        return (
          <Link
            key={tab.to}
            // 子页面地址都来自路由表里的字面量，string 只是为了让本组件通用；
            // TanStack 的严格 to 类型在调用处由字面量保证，这里收窄回去。
            to={tab.to as never}
            role="tab"
            aria-selected={active}
            className={
              "rounded border px-2.5 py-1 text-xs transition " +
              (active ? "border-brand font-medium text-fg" : "border-line text-muted hover:text-fg")
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
