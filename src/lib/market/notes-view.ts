/**
 * 这个文件是干什么的：
 * 笔记页的小工具：把「2026-10-14 10:00」这种时间说成「3 天前」。
 *
 * 为什么单独一个文件：inbox 页也有一份 relTime，两处各写一份、改一处忘一处，
 * 页面就会一个说「3 天前」一个说「3 天」。这类漂移很难查，所以合成一处。
 *
 * 你需要知道的：
 * - `now` 由调用方传（测试里可固定），不在函数里读系统时钟——否则测试没法写。
 * - 时间格式认不出来就**原样返回**：显示 `2026-10-14 10:00` 总比显示「NaN 天前」强。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 「刚刚 / 12 分钟前 / 3 天前 / 2026-10-14 10:00」。 */
export function relTimeOf(at: string, now = Date.now()): string {
  const t = new Date(`${at.replace(" ", "T")}+08:00`).getTime();
  if (!Number.isFinite(t)) return at;
  const diff = now - t;
  if (diff < 0) return at.slice(0, 10);
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return at.slice(0, 10);
}