/**
 * 这个文件是干什么的：
 * 「对齐两本账」的服务端。把浏览器本地账（localStorage chiheng-paper-v3）
 * 合并进服务端账（data/books/<userId>.json），从此只有一本正账。
 *
 * 你需要知道的：
 * 1. **合并规则写死在 journal-merge.ts**：以服务端为正账，同一天同一笔
 *    （style:id）保留服务端，只补服务端没有的。重复点是幂等的——连点两次
 *    按钮，第二次全是 duplicated，账本不变。
 * 2. **合并前自动备份**（journal-backup.ts，落 ~/chiheng-backup，带日期清理）。
 *    账本变更是不可逆动作，备份是回滚的唯一起点。
 * 3. 合并后 challenger 判决/策略闸不在这里重算——record-journal 每分钟
 *    一轮自己读账本重算，最迟一分钟跟上。
 * 4. validator 宽松但限量（days ≤ 80、总 trades ≤ 2000）：这是给正常浏览器
 *    账用的，不是给批量导入用的；超限直接拒，不截断（截断=悄悄丢数据）。
 */

import { createServerFn } from "@tanstack/react-start";
import { requireUserId } from "@/lib/auth/verify.server";
import { readUserBook, writeUserBook } from "@/lib/market/book-file";
import { backupJournal } from "@/lib/market/journal-backup";
import { mergeBooks, type MergeStats } from "@/lib/market/journal-merge";
import { shanghaiDate } from "@/lib/market/session";
import type { PaperDay } from "@/lib/paper";

/** 上限：和 paper.ts 的 days.slice(0, 80) 对齐；trades 总数留足一天 10 只 × 80 天。 */
const MAX_DAYS = 80;
const MAX_TRADES = 2000;

/** 宽松校验浏览器账。坏项跳过并计数——不截断好数据，也不让一条坏数据废掉整批。 */
export function parseBrowserDays(data: unknown): { days: PaperDay[]; dropped: number } {
  if (!Array.isArray(data)) return { days: [], dropped: 0 };
  const days: PaperDay[] = [];
  let dropped = 0;
  for (const item of data) {
    const d = item as Partial<PaperDay> | null;
    if (d && typeof d.date === "string" && Array.isArray(d.trades)) days.push(d as PaperDay);
    else dropped += 1;
  }
  if (days.length > MAX_DAYS || days.reduce((sum, d) => sum + d.trades.length, 0) > MAX_TRADES) {
    throw new Error(`浏览器账超出上限（${days.length} 天 / 上限 ${MAX_DAYS}）——这不是正常浏览器账的形状，拒绝合并`);
  }
  return { days, dropped };
}

export const mergeBrowserJournal = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseBrowserDays(data))
  .handler(async ({ data }): Promise<{ stats: MergeStats; dropped: number; serverDaysBefore: number }> => {
    const userId = await requireUserId();
    const book = await readUserBook<PaperDay>(userId);
    if (data.days.length === 0) {
      // 浏览器账是空的：没什么可合，但别报错——用户可能就是来确认一下的。
      return { stats: { addedDays: 0, addedTrades: 0, duplicatedTrades: 0, stylessTrades: 0, invalidDays: 0 }, dropped: data.dropped, serverDaysBefore: book.days.length };
    }
    // 先备份再动账（同日第二次合并会覆盖当天备份，但那时已幂等无实际变更）。
    // 备份失败不抛——backupJournal 自己返回原因；正账在，合并不丢服务端数据，
    // 但要把失败说出来，让人知道这次合并没有回滚起点。
    const backup = await backupJournal(userId, shanghaiDate());
    if (!backup.ok) console.warn(`[merge] 合并前备份失败（已继续合并）：${backup.reason}`);
    const { days, stats } = mergeBooks(book.days, data.days);
    await writeUserBook(userId, { joinedAt: book.joinedAt, days, nextSettleAt: book.nextSettleAt });
    return { stats, dropped: data.dropped, serverDaysBefore: book.days.length };
  });
