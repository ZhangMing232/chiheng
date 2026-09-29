import { useEffect, useState } from "react";
import { signedPct } from "@/lib/market/format";
import { evaluate, TRACK_NEED } from "@/lib/market/model";
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
  bookReady,
  indexPrice,
}: {
  quotes: Quote[];
  live: boolean;
  sealed: boolean;
  date: string;
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
    if (!ready || !sealed || !live || !bookReady || !date) return;
    const trades: PaperTrade[] = [];
    for (const quote of quotes) {
      if (!evaluate("early", quote, true, true) || !(quote.price > 0)) continue;
      trades.push({ id: quote.id, code: quote.code, name: quote.name, entry: quote.price, exit: null, exitDate: null });
    }
    recordDay({ date, savedAt: Date.now(), indexEntry: indexPrice, indexExit: null, trades });
  }, [ready, sealed, live, bookReady, date, quotes, indexPrice, recordDay]);

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

  const logged = days.length;
  const settled = days.flatMap((day) =>
    day.trades
      .filter((trade) => trade.exit != null && trade.entry > 0 && day.indexExit != null && day.indexEntry)
      .map((trade) => ({
        ...trade,
        date: day.date,
        stock: trade.exit! / trade.entry - 1,
        index: day.indexExit! / day.indexEntry! - 1,
      })),
  );

  return (
    <section className="mt-3 max-w-3xl rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">和沪深 300 比</h2>
        <span className="tabular-nums text-xs text-muted">
          {logged}/{TRACK_NEED} 个交易日
        </span>
      </div>
      <p className="mt-2 text-pretty text-muted">
        每个交易日 15:00 后，把当天通过启动前期的名单和沪深 300 一起记下。持股按 8 个交易日结算，落在 5 到 10 天里面。记满 {TRACK_NEED}{" "}
        个交易日之前，不计算成功率，默认空仓。
      </p>
      {logged < TRACK_NEED ? (
        <p className="mt-2">还差 {TRACK_NEED - logged} 个交易日。现在这些记录不能用来判断这套规则赚不赚钱。</p>
      ) : (
        <p className="mt-2">已经记满 {TRACK_NEED} 个交易日，可以看下面每一笔相对沪深 300 的涨跌。这仍然不是买卖指令。</p>
      )}
      {days[0]?.date === date ? (
        <p className="mt-2">
          {date} 已记下 {days[0].trades.length} 只
          {days[0].trades.length === 0 ? "，当天是空仓。" : `：${days[0].trades.map((trade) => trade.name).join("、")}`}
        </p>
      ) : (
        <p className="mt-2 text-muted">{sealed ? "今天的名单还没写下。" : "未到收盘，今天先不记。"}</p>
      )}
      {settled.length > 0 && logged >= TRACK_NEED ? (
        <ul className="mt-2 flex flex-col gap-1 text-muted">
          {settled.slice(0, 8).map((trade) => (
            <li key={`${trade.date}-${trade.id}`} className="tabular-nums">
              {trade.name} {signedPct(trade.stock * 100)}，沪深 300 {signedPct(trade.index * 100)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
