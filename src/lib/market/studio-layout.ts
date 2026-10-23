/**
 * 这个文件是干什么的：
 * 自媒体图文的**共享布局计算**。SVG 路线和 canvas 路线共用同一套算法——
 * 两边各算各的必然对不上（用户切换渲染路径时图会变样）。
 *
 * 你需要知道的：
 * - 竖版 1080×1920 是固定画布，内容少时**下面空一半**，出来像"没做完的图"。
 *   所以行高要按剩余空间自适应放大。
 * - 带小字（note）的行 +20：小字要容得下，否则会画到下一张卡片上。
 * - 增量封顶 MAX_ROW_EXTRA：不然 3 条时每行拉到 400px，变成巨型色块不像榜单。
 * - 空间不够时不缩（宁可溢出也不要压扁）。
 */

/**
 * 单行最大增量（px）。
 * 80 是第一版（竖版底部还空一大片，看着像没做完）；提到 140 后 5 条能占 85%。
 * 再高就成了巨型色块，不像榜单了。
 */
export const MAX_ROW_EXTRA = 140;

/** 底部预留：事实行 + 免责区。 */
export const FOOT_ROOM = 180;

/**
 * 排名列表的行高分配。
 *
 * @param items    条目（只关心有没有 note）
 * @param available 可用高度（画布高 - 内容起点 - 底部预留）
 * @param base     基础行高（条数多时用小的）
 */
export function rankRowHeights(
  items: readonly { note?: string }[],
  available: number,
  base: number,
): number[] {
  if (items.length === 0) return [];
  const baseHeights = items.map((it) => (it.note ? base + 20 : base));
  const total = baseHeights.reduce((s, h) => s + h, 0);
  const extra = Math.floor((available - total) / items.length);
  const add = Math.max(0, Math.min(extra, MAX_ROW_EXTRA));
  return baseHeights.map((h) => h + add);
}

/** 条目多时用紧凑行高。 */
export function baseRowHeight(count: number): number {
  return count > 10 ? 96 : 112;
}
