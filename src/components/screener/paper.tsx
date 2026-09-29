import { useEffect, useState } from "react";
import { screen } from "@/lib/market/model";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { dayLocked, exitFill, nthClose } from "@/lib/market/journal-book";
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

  // 尾盘先记临时价，收盘才锁定。同一版规则里，已经写下的买入价不跟着刷新改。
  useEffect(() => {
    if (!ready || !live || !bookReady || !date) return;
    const closeWindow = signalTime >= "14:40" && signalTime < "15:00";
    if (!sealed && !closeWindow) return;
    const existing = usePaper.getState().days.find((day) => day.date === date);
    if (existing && dayLocked(existing)) return;
    const same = existing && (existing.ruleVersion ?? 1) === rules.version;
    const prior = new Map(same ? existing.trades.map((trade) => [trade.id, trade.entry]) : []);
    const trades: PaperTrade[] = [];
    for (const quote of quotes) {
      if (!screen(quote, true, rules) || !matchPrefs(quote, prefs) || !(quote.price > 0)) continue;
      const kept = prior.get(quote.id);
      trades.push({
        id: quote.id,
        code: quote.code,
        name: quote.name,
        entry: kept && kept > 0 ? kept : quote.price,
        exit: null,
        exitDate: null,
      });
    }
    if (!sealed && trades.length === 0) return;
    recordDay({
      date,
      savedAt: Date.now(),
      signalTime: same ? existing.signalTime : sealed ? "15:00" : signalTime,
      status: sealed ? "locked" : "provisional",
      ruleVersion: rules.version,
      indexEntry: same ? (existing.indexEntry ?? indexPrice) : indexPrice,
      indexExit: same ? existing.indexExit : null,
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
            const filled = exitFill(data.bars ?? [], day.date, trade.entry);
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
  }, [ready, openKey, settle, settleIndex]);

  return null;
}
