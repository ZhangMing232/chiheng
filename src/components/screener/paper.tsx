/**
 * 这个文件是干什么的：
 * 挂在选股页上的记账块。它自己不画任何界面，只在后台盯着现价。
 * 符合条件就往模拟账里记买入或卖出。
 *
 * 你需要知道的：
 * 现价打到买入价才记。已经记下的买入价不再改。跌停先不卖，等能卖再结算。
 */

import { useEffect, useState } from "react";
import { STYLE_IDS, takeBuys, watchList, type Listed } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { boardLimit, limitTag, planExit } from "@/lib/market/model";
import { exitFill, nthClose } from "@/lib/market/journal-book";
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
    const trades: PaperTrade[] = [];
    for (const style of STYLE_IDS) {
      const list =
        style === "relay" ? relay.filter((row) => matchPrefs(row.quote, prefs)) : watchList(quotes, style, rules, (quote) => matchPrefs(quote, prefs));
      for (const row of takeBuys(list, held, style)) {
        trades.push({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          hold: style === "relay" ? 1 : undefined,
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
        if (quote.price <= plan.stop) settle(day.date, trade.id, plan.stop, date, trade.entry);
        else if (quote.price >= plan.target) settle(day.date, trade.id, plan.target, date, trade.entry);
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
              trade.hold ?? 8,
            );
            if (!filled) continue;
            settle(day.date, trade.id, filled.price, filled.date, trade.entry);
          } catch {
            // 还没走到第 8 个交易日，或日线暂时没返回。
          }
        }
        if (day.indexExit == null && day.indexEntry != null) {
          try {
            const data = await getKline({ data: { id: "sh000300" } });
            const next = nthClose(data.bars ?? [], day.date);
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
