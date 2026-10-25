/**
 * 这个文件是干什么的：
 * 【已退役，2026-10-25】挂在选股页上的记账块。它自己不画任何界面，只在后台盯着现价。
 * 符合条件就往模拟账里记买入或卖出。
 *
 * 退役原因：两本账对齐。记账改由服务端进程写（data/books，见 record-journal.ts），
 * 浏览器这本（localStorage chiheng-paper-v3）只有选股页开着才会长数据，
 * 换设备/没开页面就断账。2026-10-25 起选股页摘除了本组件挂载（screener.tsx 头注有记），
 * 本文件保留只为：① 本地旧数据的结构参考；② 万一要回滚知道去哪儿找。
 * **没有任何页面再挂它**——重新挂载等于重新制造两本账。
 *
 * 你需要知道的（退役前口径，读旧数据用）：
 * 现价打到买入价才记。已经记下的买入价不再改。跌停先不卖，等能卖再结算。
 */

import { useEffect, useState } from "react";
import { ACTIVE_STYLES, holdOf, takeBuys, watchList, type Listed } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { boardLimit, HOLD_SESSIONS, limitTag, planExit } from "@/lib/market/model";
import { exitFill, nthClose } from "@/lib/market/journal-book";
import { intradayFill } from "@/lib/market/intraday-fill";
import type { EarlyRules } from "@/lib/market/rules";
import { getKline } from "@/lib/market/quotes.functions";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperTrade } from "@/lib/paper";

/** 不显示任何内容。行情够新时记下打到买入价的票，并把该止损或该止盈的旧仓结算掉。 */
export function Journal({
  quotes,
  live,
  matching,
  date,
  signalTime,
  bookReady,
  indexPrice,
  rules,
  prefs,
  relay,
}: {
  quotes: Quote[];
  live: boolean;
  matching: boolean;
  date: string;
  signalTime: string;
  bookReady: boolean;
  indexPrice: number | null;
  rules: EarlyRules;
  prefs: Prefs;
  relay: Listed[];
}) {
  const days = usePaper((state) => state.days);
  const recordDay = usePaper((state) => state.recordDay);
  const settle = usePaper((state) => state.settle);
  const settleIndex = usePaper((state) => state.settleIndex);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      await usePaper.persist.rehydrate();
      if (!cancel) setReady(true);
    })();
    return () => {
      cancel = true;
    };
  }, []);

  // 现价打到这只股票的买入价才记。已经记下的买入价不再改。
  useEffect(() => {
    if (!ready || !live || !matching || !bookReady || !date) return;
    const book = usePaper.getState().days;
    const held = book.flatMap((day) => day.trades);
    // 名额按天算：只数今天已经记下的那几只，前几天还没卖出的不占今天的名额。
    const todayTrades = book.find((day) => day.date === date)?.trades ?? [];
    const trades: PaperTrade[] = [];
    for (const style of ACTIVE_STYLES) {
      const list =
        style === "relay" ? relay.filter((row) => matchPrefs(row.quote, prefs)) : watchList(quotes, style, rules, (quote) => matchPrefs(quote, prefs));
      for (const row of takeBuys(list, held, style, todayTrades)) {
        trades.push({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          hold: holdOf(style),
          exit: null,
          exitDate: null,
        });
      }
    }
    if (trades.length > 0) {
      const existing = book.find((day) => day.date === date);
      recordDay({
        date,
        savedAt: Date.now(),
        signalTime: existing?.signalTime ?? signalTime,
        status: matching ? "provisional" : "locked",
        ruleVersion: rules.version,
        indexEntry: existing?.indexEntry ?? indexPrice,
        indexExit: existing?.indexExit ?? null,
        trades,
      });
    }
    for (const day of book) {
      if (day.date >= date) continue;
      for (const trade of day.trades) {
        if (trade.exit != null) continue;
        const quote = quotes.find((item) => item.id === trade.id);
        if (!quote || limitTag(quote) === "跌停") continue;
        const plan = trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
        // 和记账脚本用同一个函数：判定和记账必须是同一个价。曾经这里判定用现价、
        // 记账用 plan.stop，账上虚记最多 9.5 个百分点——两套账同病就得同治。
        const fill = intradayFill(quote.price, plan.stop, plan.target);
        if (fill) settle(day.date, trade.id, fill.price, date, trade.entry, "intraday");
      }
    }
  }, [ready, live, matching, bookReady, date, signalTime, quotes, indexPrice, recordDay, rules, prefs, relay, settle]);

  const openKey = days
    .flatMap((day) => [
      ...day.trades.filter((trade) => trade.exit == null).map((trade) => `${day.date}:${trade.id}`),
      day.indexExit == null && day.indexEntry != null ? `${day.date}:index` : "",
    ])
    .filter(Boolean)
    .join("|");

  useEffect(() => {
    if (!ready || !openKey) return;
    let cancel = false;
    const book = usePaper.getState().days;
    void (async () => {
      for (const day of book) {
        if (cancel) return;
        for (const trade of day.trades) {
          if (trade.exit != null) continue;
          try {
            const data = await getKline({ data: { id: trade.id } });
            const plan =
              trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
            const filled = exitFill(
              data.bars ?? [],
              day.date,
              trade.entry,
              plan.stop,
              plan.target,
              boardLimit(trade.id, trade.name),
              trade.hold ?? HOLD_SESSIONS,
            );
            if (!filled) continue;
            settle(day.date, trade.id, filled.price, filled.date, trade.entry, "daily");
          } catch {
            // 还没走到结算日（默认 8 个交易日），或日线暂时没返回。
          }
        }
        if (day.indexExit == null && day.indexEntry != null) {
          try {
            const data = await getKline({ data: { id: "sh000300" } });
            // 同一天的持仓天数不一样（次日补涨 1 天、多数 8 天、中期反转 10 天），
            // 指数对照一天只有一个数，按最长的那个算，往对自己不利的方向偏。
            const longest = day.trades.reduce((max, trade) => Math.max(max, trade.hold ?? HOLD_SESSIONS), HOLD_SESSIONS);
            const next = nthClose(data.bars ?? [], day.date, longest);
            if (next) settleIndex(day.date, next.price);
          } catch {
            // 沪深 300 的日线还没走到结算日。
          }
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [ready, openKey, settle, settleIndex, rules]);

  return null;
}
