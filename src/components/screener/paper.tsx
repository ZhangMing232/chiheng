import { useEffect, useState } from "react";
import { quoteOrder, slotsLeft, styleOf } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { planExit } from "@/lib/market/model";
import { exitFill, nthClose } from "@/lib/market/journal-book";
import type { EarlyRules } from "@/lib/market/rules";
import { getKline } from "@/lib/market/quotes.functions";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperTrade } from "@/lib/paper";

export function Journal({
  quotes,
  live,
  sealed,
  date,
  signalTime,
  bookReady,
  indexPrice,
  rules,
  prefs,
}: {
  quotes: Quote[];
  live: boolean;
  sealed: boolean;
  date: string;
  signalTime: string;
  bookReady: boolean;
  indexPrice: number | null;
  rules: EarlyRules;
  prefs: Prefs;
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
    if (!ready || !live || !bookReady || !date) return;
    const book = usePaper.getState().days;
    const held = book.flatMap((day) => day.trades);
    const room = slotsLeft(held, prefs.style);
    if (room <= 0) return;
    const openIds = new Set(held.filter((trade) => trade.exit == null && styleOf(trade) === prefs.style).map((trade) => trade.id));
    const hits: { score: number; trade: PaperTrade }[] = [];
    for (const quote of quotes) {
      if (openIds.has(quote.id)) continue;
      const order = quoteOrder(prefs.style, quote, rules);
      if (!order?.hit || !matchPrefs(quote, prefs)) continue;
      hits.push({
        score: order.score,
        trade: {
          id: quote.id,
          code: quote.code,
          name: quote.name,
          entry: order.buy,
          stop: order.stop,
          target: order.sell,
          style: prefs.style,
          exit: null,
          exitDate: null,
        },
      });
    }
    const trades = hits
      .sort((a, b) => b.score - a.score)
      .slice(0, room)
      .map((item) => item.trade);
    if (trades.length === 0) return;
    const existing = book.find((day) => day.date === date);
    recordDay({
      date,
      savedAt: Date.now(),
      signalTime: existing?.signalTime ?? signalTime,
      status: sealed ? "locked" : "provisional",
      ruleVersion: rules.version,
      indexEntry: existing?.indexEntry ?? indexPrice,
      indexExit: existing?.indexExit ?? null,
      trades,
    });
  }, [ready, sealed, live, bookReady, date, signalTime, quotes, indexPrice, recordDay, rules, prefs]);

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
            const filled = exitFill(data.bars ?? [], day.date, trade.entry, plan.stop, plan.target);
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
