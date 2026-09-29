import { useEffect, useState } from "react";
import { evaluate } from "@/lib/market/model";
import { getKline } from "@/lib/market/quotes.functions";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperTrade } from "@/lib/paper";

const CHECK_DAYS = 8;

function normDate(value: string): string {
  const match = value.match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function barAfter(bars: { date: string; c: number }[], date: string, sessions: number) {
  const index = bars.findIndex((bar) => normDate(bar.date) === date);
  if (index < 0) return null;
  let left = sessions;
  for (let cursor = index + 1; cursor < bars.length; cursor += 1) {
    left -= 1;
    if (left === 0) return bars[cursor];
  }
  return null;
}

export function Journal({
  quotes,
  live,
  sealed,
  date,
  signalTime,
  bookReady,
  indexPrice,
}: {
  quotes: Quote[];
  live: boolean;
  sealed: boolean;
  date: string;
  signalTime: string;
  bookReady: boolean;
  indexPrice: number | null;
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

  useEffect(() => {
    if (!ready || !live || !bookReady || !date) return;
    if (!sealed && !signalTime) return;
    const openWindow = signalTime >= "09:25" && signalTime <= "09:30";
    const closeWindow = signalTime >= "14:40" && signalTime < "15:00";
    if (!sealed && !openWindow && !closeWindow) return;
    const strict = sealed || closeWindow;
    const trades: PaperTrade[] = [];
    for (const quote of quotes) {
      if (!evaluate("early", quote, true, strict) || !(quote.price > 0)) continue;
      trades.push({ id: quote.id, code: quote.code, name: quote.name, entry: quote.price, exit: null, exitDate: null });
    }
    if (!sealed && trades.length === 0) return;
    recordDay({
      date,
      savedAt: Date.now(),
      signalTime: signalTime || "15:00",
      indexEntry: indexPrice,
      indexExit: null,
      trades,
    });
  }, [ready, sealed, live, bookReady, date, signalTime, quotes, indexPrice, recordDay]);

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
            const next = barAfter(data.bars ?? [], day.date, CHECK_DAYS);
            if (!next || !(next.c > 0)) continue;
            const entryBar = (data.bars ?? []).find((bar) => normDate(bar.date) === day.date);
            settle(day.date, trade.id, next.c, normDate(next.date), entryBar && entryBar.c > 0 ? entryBar.c : trade.entry);
          } catch {
            // 还没走到第 8 个交易日，或日线暂时没返回。
          }
        }
        if (day.indexExit == null && day.indexEntry != null) {
          try {
            const data = await getKline({ data: { id: "sh000300" } });
            const next = barAfter(data.bars ?? [], day.date, CHECK_DAYS);
            if (next && next.c > 0) settleIndex(day.date, next.c);
          } catch {
            // 沪深 300 的日线还没走到结算日。
          }
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [ready, openKey, settle, settleIndex]);

  return null;
}
