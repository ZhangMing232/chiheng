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
        // 索引 tab（to 以 / 结尾）只允许精确匹配：不然 /research/reports 会同时
        // 点亮「个股研判」（/research 是它的前缀），两个 tab 同亮，读者不知道自己在哪。
        const active = tab.to.endsWith("/") ? path === target : path === target || path.startsWith(target + "/");
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

/** 「研究」区的二级 tab（2026-10-26 四个平级页合成一页：个股研判/多空辩论/研报库/笔记）。 */
/** 「复盘」区的二级 tab（2026-11-11 把 /overview 涨跌分布并进来；同一天把
 *  资金流向拆出去成平级的 /flow——它自己有 8 个子页，再挂在这里就是三层导航）。 */
export const REVIEW_TABS: SectionTab[] = [
  { to: "/review/", label: "每日复盘" },
  { to: "/review/breadth", label: "涨跌分布" },
  { to: "/review/signals", label: "信号" },
  { to: "/review/events", label: "公司事件" },
];

export const RESEARCH_TABS: SectionTab[] = [
  { to: "/research/", label: "个股研判" },
  { to: "/research/debate", label: "多空辩论" },
  { to: "/research/reports", label: "研报库" },
  { to: "/research/notes", label: "笔记" },
];

/** 「题材」区（2026-11-11 三个平级页合成一页）：消息从哪来 → 钱在往哪去 → 里面哪几只。 */
export const THEME_TABS: SectionTab[] = [
  { to: "/themes/intel", label: "市场情报" },
  { to: "/themes/rotation", label: "题材轮动" },
  { to: "/themes/brief", label: "题材简报" },
];

/** 「游资与席位」区（2026-11-11 合并）：今天谁在买 → 跟这些席位买到底赚不赚。 */
export const YOUZI_TABS: SectionTab[] = [
  { to: "/youzi/track", label: "游资追踪" },
  { to: "/youzi/seats", label: "席位档案" },
];
