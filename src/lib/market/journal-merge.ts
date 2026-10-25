/**
 * 这个文件是干什么的：
 * 把「浏览器本地账」合并进「服务端账」——两本账对齐的唯一入口。
 *
 * 为什么需要（2026-10-25，用户要求「把两本帐对齐」）：
 * 系统里长期存在两本各自为政的账：
 * - **服务端账** `data/books/<userId>.json`：记账进程（record-journal.ts）
 *   每分钟自动写。多端可见、有备份、challenger 判决和 hardGate 都读它——正账。
 * - **浏览器账** localStorage `chiheng-paper-v3`（usePaper）：选股页挂着的
 *   Journal 组件在用户开着页面时写。只在这台浏览器，服务端永远看不到。
 * 两本账记的是同一套规则的同一些单，于是分叉：服务端挂掉时 positions 页
 * 退化显示浏览器账，用户看到的是另一套数字（2026-10-05「账本全是 0」
 * 事故就是这类分叉的变体）。
 *
 * 合并规则（写死，不自行适配）：
 * - **以服务端账为正账**：同一天同一笔（style:id）两边都有，保留服务端，
 *   不用浏览器的覆盖——服务端是进程按同一规则记的，且是判决链的输入。
 * - 只做**补录**：服务端没有的天整天的加；有的天补服务端没有的笔。
 * - 去重键和 paper.ts recordDay 同款：`${style}:${id}`。**没有 style 的
 *   旧账 trade 不合并不统计**——recordDay 历来就跳它们（不建键），
 *   合并照抄，宁可少合也不重。
 * - indexEntry/indexExit：服务端为 null 时才用浏览器的兜底（别用旧值盖新值）。
 *
 * 纯函数，不碰 fs/网络——浏览器端（合并前预览）和服务端（serverFn）共用。
 */

import type { PaperDay, PaperTrade } from "@/lib/paper";

/** 一笔的合并去重键。没有 style 的返回 null——调用方按「不合并不统计」处理。 */
export function tradeKey(trade: PaperTrade): string | null {
  return trade.style ? `${trade.style}:${trade.id}` : null;
}

export type MergeStats = {
  /** 服务端原本没有、整本加入的天数。 */
  addedDays: number;
  /** 补录进已有天的笔数。 */
  addedTrades: number;
  /** 两边都有、按服务端保留的笔数（重复）。 */
  duplicatedTrades: number;
  /** 没有 style、不合并不统计的笔数（recordDay 同款取舍）。 */
  stylessTrades: number;
  /** 结构不对被丢弃的浏览器账天数（缺 date 或缺 trades 数组）。 */
  invalidDays: number;
};

export type MergeResult = {
  days: PaperDay[];
  stats: MergeStats;
};

const EMPTY_STATS: MergeStats = {
  addedDays: 0,
  addedTrades: 0,
  duplicatedTrades: 0,
  stylessTrades: 0,
  invalidDays: 0,
};

/** 同一天两本账字段兜底：服务端优先，服务端没有的用浏览器补。index 只在服务端为 null 时兜底。 */
function mergeDay(server: PaperDay, browser: PaperDay, stats: MergeStats): PaperDay {
  const existingKeys = new Set(server.trades.map(tradeKey).filter((k): k is string => k != null));
  const extras: PaperTrade[] = [];
  for (const trade of browser.trades) {
    const key = tradeKey(trade);
    if (key == null) {
      stats.stylessTrades += 1;
      continue;
    }
    if (existingKeys.has(key)) {
      stats.duplicatedTrades += 1;
      continue;
    }
    existingKeys.add(key);
    extras.push(trade);
  }
  stats.addedTrades += extras.length;
  return {
    ...server,
    // 服务端的为准；这些字段服务端一定有（正账），兜底是防老数据缺字段
    signalTime: server.signalTime || browser.signalTime,
    status: server.status ?? browser.status,
    ruleVersion: server.ruleVersion ?? browser.ruleVersion,
    indexEntry: server.indexEntry ?? browser.indexEntry,
    indexExit: server.indexExit ?? browser.indexExit,
    savedAt: Math.max(server.savedAt ?? 0, browser.savedAt ?? 0),
    trades: [...server.trades, ...extras],
  };
}

/**
 * 合并两本账。不改入参，返回新数组。
 * 输出按日期降序（账本惯例：recordDay 也是把新天插在最前）。
 */
export function mergeBooks(server: PaperDay[], browser: PaperDay[]): MergeResult {
  const stats: MergeStats = { ...EMPTY_STATS };
  const byDate = new Map(server.map((day) => [day.date, day]));
  for (const day of browser) {
    if (!day || typeof day.date !== "string" || !Array.isArray(day.trades)) {
      stats.invalidDays += 1;
      continue;
    }
    const hit = byDate.get(day.date);
    if (hit) {
      byDate.set(day.date, mergeDay(hit, day, stats));
    } else {
      byDate.set(day.date, day);
      stats.addedDays += 1;
    }
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  return { days, stats };
}

/**
 * 合并前预览（给 UI 在确认弹窗里显示「会发生什么」）。
 * 只算统计，不产账——和 mergeBooks 同一套规则，数字必须一致。
 */
export function previewMerge(server: PaperDay[], browser: PaperDay[]): MergeStats {
  return mergeBooks(server, browser).stats;
}
