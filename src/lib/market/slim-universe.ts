/**
 * 瘦身全市场快照。
 *
 * 背景：全市场快照有 ~5300 只股票，序列化进 SSR HTML 约 1.2MB。
 * 手机 Safari 解析 + 反序列化这份数据时会卡住主线程，表现为「点击没反应、页面很卡」。
 * 大多数页面只用其中持仓相关的几只（按 id 查现价/涨跌），
 * 所以在 loader 里先按 id 过滤，只把这少量股票交给 SSR 序列化。
 *
 * 用法：
 *   return { ..., universe: slimUniverse(universe, ids) }
 * 过滤后保留完整 Quote 字段（数量少，无所谓），页面组件无需任何改动。
 */

import type { Quote, Universe } from "./types";
import { limitTag } from "./model.ts";

export function slimUniverse(universe: Universe | null, ids: Iterable<string>): Universe | null {
  if (!universe) return null;
  const keep = new Set(ids);
  return { ...universe, quotes: universe.quotes.filter((quote) => keep.has(quote.id)) };
}

/** 从账本所有交易里收集股票 id（持仓 + 已平仓都要，页面常显示历史交易）。 */
export function journalTradeIds(journal: { days: { trades: { id: string }[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const day of journal.days) {
    for (const trade of day.trades) ids.add(trade.id);
  }
  return ids;
}

/** 涨跌家数 / 涨跌停统计。必须在瘦身前对全量快照算（瘦身后的列表只剩几只，算出来不对）。 */
export type Breadth = {
  up: number;
  down: number;
  flat: number;
  limitUp: number;
  limitDown: number;
};

export function marketBreadth(quotes: Quote[]): Breadth {
  let up = 0;
  let down = 0;
  let flat = 0;
  let limitUp = 0;
  let limitDown = 0;
  for (const quote of quotes) {
    const chg = quote.chg;
    if (chg == null) continue;
    if (chg > 0.001) up += 1;
    else if (chg < -0.001) down += 1;
    else flat += 1;
    const tag = limitTag(quote);
    if (tag === "涨停") limitUp += 1;
    else if (tag === "跌停") limitDown += 1;
  }
  return { up, down, flat, limitUp, limitDown };
}
