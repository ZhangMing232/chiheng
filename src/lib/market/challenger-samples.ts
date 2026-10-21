/**
 * 这个文件是干什么的：
 * 从全用户账本里收集挑战者纸面样本行（variant=挑战者id 的交易）。
 *
 * 你需要知道的：
 * 诊断（agent-loop）和策略提议（strategy-ai）都要看挑战者攒样进度，
 * 账本读取逻辑只写这一处。读失败返回空数组——样本进度是增强项，
 * 诊断/提议不能因为账本读不到而缺席。
 */

import { listUserIds, readUserBook } from "./book-file.ts";

/** 一条挑战者样本：哪个挑战者、平仓没有、建仓日。 */
export type ChallengerSample = { variant: string; exit: number | null; date: string };

/** 全用户账本里所有 variant 行。没有任何账本时返回空数组。 */
export async function collectChallengerSamples(): Promise<ChallengerSample[]> {
  const out: ChallengerSample[] = [];
  type BookTrade = { variant?: string; exit?: number | null };
  type BookDay = { date?: string; trades?: BookTrade[] };
  for (const uid of await listUserIds()) {
    const book = await readUserBook<BookDay>(uid);
    for (const day of book.days ?? []) {
      for (const t of day.trades ?? []) {
        if (typeof t.variant !== "string" || t.variant.length === 0) continue;
        out.push({ variant: t.variant, exit: t.exit ?? null, date: day.date ?? "" });
      }
    }
  }
  return out;
}
