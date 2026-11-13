/**
 * 这个文件是干什么的：
 * 一条「口径说明」——页面顶部（或面板底部）那块「这个数字是按什么算的、
 * 和另一页同名的数字不是一回事」的统一说法。全站一处，别再各页手写。
 *
 * 为什么抽出来（2026-11-13）：
 * /today 的「今日情绪档」和 /cycle 的「周期阶段」都会写「冰点 / 退潮」，
 * 但一个按盘中炸板率绝对阈值、一个按 250 日温度历史分位。原来只把区别藏在
 * PixelSummary 的 title 属性里，用户看不见，才会拿「温和」对「冰点」说矛盾。
 * P0 对账之后又多了一条更要紧的：理论成交（按日 K 事后重算）与账本真实成交
 * （当时记下）绝不互相冒充。两处的说明条是复制粘贴出来的，改一处漏一处。
 *
 * 归它管的：
 * - 页顶横条（variant="bar"）：带边框，标签 + 正文 + 可选的对照链接；
 * - 面板内脚注（variant="footnote"）：只留上分隔线，不带边框，标签照样给。
 *
 * 不归它管的（别硬套，会破坏版式）：
 * - Panel 里「缺口 / 口径」列表项（/interval、/youzi/seats 的 <Tag>口径</Tag>）；
 * - 表格列的口径摘要、Panel 标题里的口径、图表下方的长篇统计说明。
 * 那些是内容的一部分，不是一条独立的说明横幅。
 *
 * 纪律：只放说明文字与链接，不承载数据。数据由各页自己的 loader 给，
 * 免得出现两处都声称「现在是几点几分」的第二个真相（同 PixelHeader 的规矩）。
 * 链接样式统一走 scopeNoteLinkClass，调用方自己用 TanStack 的 <Link> 传进来——
 * 组件不 import 路由库，纯展示，测试与离线稿都能直接渲染。
 */

import type { ReactNode } from "react";

/** 对照链接的统一样式：虚线下划线是「这里能跳去对照」的通用暗示（同 Term）。
 *  行内块 + 上下 4px 内边距把点击区撑到 ~28px 高（check_design 实测裸链接只有 20px，
 *  py-0.5 的 24px 仍卡在它「至少 24」的严格边界上，索性留足）。 */
export const scopeNoteLinkClass =
  "inline-block shrink-0 py-1 text-brand underline decoration-dotted underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand";

export type ScopeNoteProps = {
  /** 说明的对象，写具体：今日情绪档 / 周期阶段 / 理论成交与真实成交。别写「注意」。 */
  label: string;
  /** 正文：怎么算的、什么时候更新、影响什么。可含 <b> 等行内标记。 */
  children: ReactNode;
  /** 可选的对照链接：调用方传 <Link to="…" className={scopeNoteLinkClass}>…</Link>。 */
  link?: ReactNode;
  /** 链接之后的补充（例如「两边口径不同，同名的 X 定义也不同」）。 */
  after?: ReactNode;
  /** bar = 页顶带框横条；footnote = Panel 内脚注（只有上分隔线）。默认 bar。 */
  variant?: "bar" | "footnote";
  className?: string;
};

export function ScopeNote({
  label,
  children,
  link,
  after,
  variant = "bar",
  className = "",
}: ScopeNoteProps) {
  // 两种变体只差容器：边框整条 vs 只留一条上分隔线。内容和标签完全一致，
  // 保证「一眼看出这是口径说明」在panel内外都成立。
  const wrap =
    variant === "bar"
      ? "flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-line bg-surface px-3 py-2 text-[12px] leading-relaxed text-muted"
      : "flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-2 text-[12px] leading-relaxed text-muted";

  return (
    <aside aria-label={`口径说明：${label}`} className={`${wrap} ${className}`}>
      <span className="px-num shrink-0 tracking-widest text-brand">口径 // {label}</span>
      <span className="min-w-0">{children}</span>
      {link}
      {after ? <span className="min-w-0">{after}</span> : null}
    </aside>
  );
}
