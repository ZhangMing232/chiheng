import { useEffect, useState } from "react";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { nowAction } from "@/lib/market/action";
import { BOARD_LABEL, TRACK_NEED } from "@/lib/market/model";
import { dayLocked, liveGate, lossPrice, maxDrawdown, netReturn, targetPrice } from "@/lib/market/journal-book";
import type { EarlyRules } from "@/lib/market/rules";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperDay } from "@/lib/paper";

type Pick = { quote: Quote; reasons: string[] };

function dayLabel(date: string): string {
  const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return date;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

export function Picks({
  date,
  picks,
  quotes,
  serverDays,
  rules,
  marketOpen,
  tail,
  onOpen,
}: {
  date: string;
  picks: Pick[];
  quotes: Quote[];
  serverDays: PaperDay[];
  rules: EarlyRules;
  benchmark: { name: string; price: number; pct: number } | null;
  marketOpen: boolean;
  tail: boolean;
  onOpen: (id: string) => void;
}) {
  const browserDays = usePaper((state) => state.days);
  const days = serverDays.length > 0 ? serverDays : browserDays;
  const onServer = serverDays.length > 0;
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

  const byId = new Map(quotes.map((quote) => [quote.id, quote]));
  const open = days.flatMap((day) =>
    day.trades
      .filter((trade) => trade.exit == null)
      .map((trade) => {
        const live = byId.get(trade.id);
        const ret = live && trade.entry > 0 ? netReturn(trade.entry, live.price) : null;
        return { ...trade, day: day.date, signalTime: day.signalTime ?? "", live, ret };
      }),
  );
  const closed = days.flatMap((day) =>
    day.trades
      .filter((trade) => trade.exit != null && trade.entry > 0)
      .map((trade) => ({
        ...trade,
        day: day.date,
        signalTime: day.signalTime ?? "",
        ruleVersion: day.ruleVersion ?? 1,
        ret: netReturn(trade.entry, trade.exit!),
        indexRet: day.indexEntry && day.indexExit ? day.indexExit / day.indexEntry - 1 : null,
      })),
  );
  const wins = closed.filter((trade) => trade.ret != null && trade.ret > 0).length;
  const counted = closed.filter((trade) => trade.ruleVersion === rules.version);
  const countedDays = days.filter((day) => (day.ruleVersion ?? 1) === rules.version).length;
  const ordered = counted
    .filter((trade) => trade.ret != null)
    .sort((a, b) => (a.exitDate ?? "").localeCompare(b.exitDate ?? ""))
    .map((trade) => trade.ret!);
  const gate = liveGate(countedDays, counted, ordered, rules);
  const cum = closed.reduce((sum, trade) => sum + (trade.ret ?? 0), 0);
  const indexRows = counted.filter((trade) => trade.indexRet != null);
  const indexCum = indexRows.length === 0 ? null : indexRows.reduce((sum, trade) => sum + (trade.indexRet ?? 0), 0);
  const featured = picks.slice(0, 3);
  const lockedToday = days.find((day) => day.date === date && dayLocked(day));
  const stops = open.filter((trade) => trade.live != null && trade.live.price <= lossPrice(trade.entry));
  const due = open.filter((trade) => trade.live != null && trade.live.price >= targetPrice(trade.entry));
  const now = nowAction({
    stopNames: stops.map((trade) => trade.name),
    dueNames: due.map((trade) => trade.name),
    lockedCount: lockedToday?.trades.length ?? 0,
    tail,
    marketOpen,
  });

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl bg-fg px-5 py-5 text-bg shadow-card">
        <div className="text-xs tracking-widest text-surface">现在</div>
        <h2 className="mt-2 font-serif text-2xl font-semibold text-pretty">{now.title}</h2>
        <p className="mt-2 text-sm text-pretty text-surface">{now.body}</p>
      </section>
      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-fg px-2 py-1 text-xs text-bg">{dayLabel(date)}</span>
            <h2 className="truncate text-base font-semibold">精选 {lockedToday ? lockedToday.trades.length : featured.length} 只</h2>
          </div>
          <span className="shrink-0 text-xs text-muted">{lockedToday ? "参考价已锁定" : "尾盘锁定参考价"}</span>
        </div>
        {lockedToday ? (
          lockedToday.trades.length === 0 ? (
            <p className="border-t border-line px-4 py-6 text-sm text-muted">今天已经锁定，一只都没有，记为空仓。</p>
          ) : (
            <ul>
              {lockedToday.trades.slice(0, 3).map((trade) => {
                const live = byId.get(trade.id);
                const chased = live != null && live.price > trade.entry;
                return (
                  <li key={trade.id} className="border-t border-line">
                    <button type="button" onClick={() => onOpen(trade.id)} className="block w-full px-4 py-4 text-left transition-colors hover:bg-surface-2">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-base font-semibold">
                            {trade.name}
                            <span className={"ml-2 rounded-full px-2 py-0.5 text-xs font-normal " + (chased ? "bg-up text-bg" : "bg-down-soft text-down")}>{chased ? "别追" : "可买"}</span>
                          </div>
                          <div className="mt-1 text-xs text-muted">{trade.code}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">参考买入价</div>
                          <div className="font-medium tabular-nums">低于 {fmtPrice(trade.entry)}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">目标卖出价</div>
                          <div className="font-medium tabular-nums">{fmtPrice(targetPrice(trade.entry))}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">止损价</div>
                          <div className="font-medium tabular-nums">{fmtPrice(lossPrice(trade.entry))}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">现价</div>
                          <div className="text-lg font-semibold tabular-nums">{live ? fmtPrice(live.price) : "—"}</div>
                        </div>
                      </div>
                      {chased ? <p className="mt-2 text-sm">现价已高于参考价，不要追。</p> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : featured.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            成交额要到全天 5000 万才入选，上午经常还没有。尾盘 14:40 以后才锁定买入价。
          </p>
        ) : (
          <ul>
            {featured.map((pick) => (
              <li key={pick.quote.id} className="border-t border-line">
                <button type="button" onClick={() => onOpen(pick.quote.id)} className="block w-full px-4 py-4 text-left transition-colors hover:bg-surface-2">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold">
                        {pick.quote.name}
                        <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-muted">观察</span>
                        <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-muted">
                          {BOARD_LABEL[pick.quote.board]}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted">{pick.quote.code}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">参考买入价</div>
                      <div className="font-medium tabular-nums">低于 {fmtPrice(pick.quote.price)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">目标卖出价</div>
                      <div className="font-medium tabular-nums">{fmtPrice(targetPrice(pick.quote.price))}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">止损价</div>
                      <div className="font-medium tabular-nums">{fmtPrice(lossPrice(pick.quote.price))}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">现价</div>
                      <div className="text-lg font-semibold tabular-nums">{fmtPrice(pick.quote.price)}</div>
                    </div>
                  </div>
                  {pick.reasons[0] ? <p className="mt-2 text-sm text-pretty text-muted">{pick.reasons.join("。")}</p> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">等待卖出信号的股票池 共 {open.length} 只</h2>
          <p className="mt-1 text-sm text-muted">跌到止损价就卖，涨到目标价也卖。8 个交易日内都没碰到，第 8 天收盘卖。</p>
        </div>
        {open.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {ready && !onServer ? "还没有调入的股票。尾盘锁定后才会出现在这里。" : onServer ? "服务器还没有锁定的股票。" : "正在读取记录。"}
          </p>
        ) : (
          <ul>
            {open.map((trade) => (
              <li key={`${trade.day}-${trade.id}`} className="border-t border-line px-4 py-3">
                <button type="button" onClick={() => onOpen(trade.id)} className="block w-full text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">
                        {trade.name}{" "}
                        <span className={"rounded-full px-2 py-0.5 text-xs font-normal " + (trade.live && (trade.live.price <= lossPrice(trade.entry) || trade.live.price >= targetPrice(trade.entry)) ? "bg-up text-bg" : "bg-down-soft text-down")}>
                          {trade.live && trade.live.price <= lossPrice(trade.entry) ? "止损" : trade.live && trade.live.price >= targetPrice(trade.entry) ? "卖出" : "持有"}
                        </span>{" "}
                        <span className="font-normal text-muted">({trade.code})</span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        买入信号 {trade.day} {trade.signalTime} · 参考价 {fmtPrice(trade.entry)} · 止损 {fmtPrice(lossPrice(trade.entry))} · 目标 {fmtPrice(targetPrice(trade.entry))}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={toneClass(trade.ret == null ? null : trade.ret * 100) + " text-lg font-semibold tabular-nums"}>
                        {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                      </div>
                      <div className="text-xs text-muted">
                        {trade.live && trade.live.price <= lossPrice(trade.entry)
                          ? "止损信号"
                          : trade.live && trade.live.price >= targetPrice(trade.entry)
                            ? "卖出信号"
                            : "调入以来"}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex items-baseline justify-between gap-3 px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">历史信号</h2>
          <span className="text-xs text-muted">已记录 {days.length} 天</span>
        </div>
        <div className="grid grid-cols-2 gap-2 px-4 py-4 sm:grid-cols-4">
          <div className="rounded-xl bg-surface-2 px-3 py-3">
            <div className="text-xl font-semibold tabular-nums">{closed.length === 0 ? "—" : `${((wins / closed.length) * 100).toFixed(2)}%`}</div>
            <div className="text-xs text-muted">上涨占比</div>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-3">
            <div className={"text-xl font-semibold tabular-nums " + toneClass(closed.length ? cum * 100 : null)}>
              {closed.length === 0 ? "—" : signedPct(cum * 100)}
            </div>
            <div className="text-xs text-muted">累计收益</div>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-3">
            <div className="text-xl font-semibold tabular-nums">{ordered.length === 0 ? "—" : signedPct(-maxDrawdown(ordered) * 100)}</div>
            <div className="text-xs text-muted">最大回撤</div>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-3">
            <div className={"text-xl font-semibold tabular-nums " + toneClass(indexCum == null ? null : indexCum * 100)}>
              {indexCum == null ? "—" : signedPct(indexCum * 100)}
            </div>
            <div className="text-xs text-muted">同期沪深300</div>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-pretty text-muted">
          卖出看目标价，不看 60 天。{gate.reason}。累计收益是每笔扣费后收益相加。不满 {TRACK_NEED} 个交易日时，上涨占比还只是样本。
        </p>
        {closed.length === 0 && open.length === 0 ? null : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">买入</th>
                  <th className="px-3 py-2 font-medium">卖出</th>
                  <th className="px-4 py-2 text-right font-medium">闭环</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 8).map((trade) => (
                  <tr key={`h-${trade.day}-${trade.id}`} className="border-b border-line">
                    <td className="px-4 py-3">
                      <div className="font-medium">{trade.name}</div>
                      <div className="text-xs text-muted">{trade.code}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.entry)}</div>
                      <div className="text-xs text-muted">
                        {trade.day.slice(5)} {trade.signalTime}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted">持有中</td>
                    <td className="px-4 py-3 text-right text-muted">—</td>
                  </tr>
                ))}
                {closed.slice(0, 8).map((trade) => (
                  <tr key={`c-${trade.day}-${trade.id}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{trade.name}</div>
                      <div className="text-xs text-muted">{trade.code}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.entry)}</div>
                      <div className="text-xs text-muted">
                        {trade.day.slice(5)} {trade.signalTime}
                      </div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.exit!)}</div>
                      <div className="text-xs text-muted">{trade.exitDate?.slice(5)}</div>
                    </td>
                    <td className={"px-4 py-3 text-right tabular-nums " + toneClass(trade.ret == null ? null : trade.ret * 100)}>
                      {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
