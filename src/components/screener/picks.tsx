import { useEffect, useState } from "react";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { nowAction } from "@/lib/market/action";
import { MAX_POSITIONS, STYLES, bookRisk, styleOf } from "@/lib/market/strategies";
import { BOARD_LABEL, TRACK_NEED, limitTag, planExit } from "@/lib/market/model";
import { liveGate, maxDrawdown, netReturn } from "@/lib/market/journal-book";
import type { EarlyRules } from "@/lib/market/rules";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperDay } from "@/lib/paper";

type Pick = { quote: Quote; reasons: string[]; buy: number; sell: number; stop: number; hit: boolean; block?: "limit" | "away" };

function levels(trade: { entry: number; stop?: number; target?: number }, rules: EarlyRules) {
  if (trade.stop && trade.target) return { stop: trade.stop, target: trade.target };
  return planExit(trade.entry, null, rules);
}

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
  style,
  marketOpen,
  tailHalf,
  pause,
  onStyle,
  onOpen,
}: {
  date: string;
  picks: Pick[];
  quotes: Quote[];
  serverDays: PaperDay[];
  rules: EarlyRules;
  style: "early" | "trend" | "breakout" | "value" | "relay";
  benchmark: { name: string; price: number; pct: number } | null;
  marketOpen: boolean;
  tailHalf: boolean;
  pause: string;
  onStyle: (style: "early" | "trend" | "breakout" | "value" | "relay") => void;
  onOpen: (id: string) => void;
}) {
  const browserDays = usePaper((state) => state.days);
  const source = serverDays.length > 0 ? serverDays : browserDays;
  const books = STYLES.map((item) => ({
    id: item.id,
    name: item.name,
    n: source.flatMap((day) => day.trades).filter((trade) => trade.exit == null && styleOf(trade) === item.id).length,
  }));
  const days = source
    .map((day) => ({ ...day, trades: day.trades.filter((trade) => styleOf(trade) === style) }))
    .filter((day) => day.trades.length > 0);
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
        const ret = live && trade.entry > 0 ? live.price / trade.entry - 1 : null;
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
  const featured = picks;
  const preview = style === "relay" && !tailHalf;
  const sellable = open.filter((trade) => trade.day < date);
  const stops = sellable.filter((trade) => trade.live != null && limitTag(trade.live) !== "跌停" && trade.live.price <= levels(trade, rules).stop);
  const due = sellable.filter((trade) => trade.live != null && limitTag(trade.live) !== "跌停" && trade.live.price >= levels(trade, rules).target);
  const risk = bookRisk(
    open.map((trade) => ({ style, exit: null, entry: trade.entry, stop: trade.stop })),
    style,
  );
  const now = nowAction({
    stopNames: stops.map((trade) => trade.name),
    dueNames: due.map((trade) => trade.name),
    openCount: open.length,
    tailHalf,
    marketOpen,
    relay: style === "relay",
    pause,
  });

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl bg-fg px-4 py-4 text-bg shadow-card">
        <div className="text-xs tracking-widest text-surface">现在</div>
        <h2 className="mt-1 font-serif text-xl font-semibold text-pretty">{now.title}</h2>
        <p className="mt-1 text-sm text-pretty text-surface">{now.body}</p>
      </section>
      <div className="flex flex-wrap gap-2">
        {books.map((book) => (
          <button
            key={book.id}
            type="button"
            onClick={() => onStyle(book.id)}
            className={"rounded-full px-3 py-1 text-xs " + (book.id === style ? "bg-fg text-bg" : "bg-surface-2 text-muted")}
          >
            {book.name} {book.n}/{MAX_POSITIONS}
            {book.n >= MAX_POSITIONS ? " 满" : ""}
          </button>
        ))}
      </div>
      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-fg px-2 py-1 text-xs text-bg">{dayLabel(date)}</span>
            <h2 className="truncate font-serif text-lg font-semibold">精选 {featured.length} 只</h2>
          </div>
          <span className="shrink-0 text-xs text-muted">
            {preview ? "14:30 前是预览" : style === "relay" ? "14:30 已冻结" : "打到买入价才追踪"}
          </span>
        </div>
        {featured.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {style === "relay" ? "今天没有三个够强的概念板块，或者次强已经贴着涨停、买不进。" : "这套策略现在没有符合的股票。"}
          </p>
        ) : (
          <ul>
            {featured.map((pick) => {
              const tracked = open.some((trade) => trade.id === pick.quote.id);
              const estimate = preview && !tracked;
              const elsewhere = STYLES.filter((item) => item.id !== style)
                .filter((item) =>
                  source.some((day) =>
                    day.trades.some((trade) => trade.exit == null && trade.id === pick.quote.id && styleOf(trade) === item.id),
                  ),
                )
                .map((item) => item.name);
              const badge = tracked
                ? "追踪中"
                : pick.hit && open.length >= MAX_POSITIONS
                  ? "仓位已满"
                  : pick.block === "limit"
                    ? "涨停买不进"
                    : pick.block === "away"
                      ? "不追"
                      : estimate
                        ? "尾盘再定"
                        : pick.hit
                          ? "已到买入价"
                          : "等待买入";
              return (
              <li key={pick.quote.id} className="border-t border-line">
                <button type="button" onClick={() => onOpen(pick.quote.id)} className="block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold">
                        {pick.quote.name}
                        <span className={"ml-2 rounded-full px-2 py-0.5 text-xs font-normal " + (tracked ? "bg-down-soft text-down" : pick.hit && open.length >= MAX_POSITIONS ? "bg-surface-2 text-muted" : pick.hit ? "bg-up text-bg" : "bg-surface-2 text-muted")}>
                          {badge}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {pick.quote.code} · {BOARD_LABEL[pick.quote.board]}
                        {elsewhere.length > 0 ? ` · 另有 ${elsewhere.join("、")} 持有` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-muted">现价</div>
                      <div className="text-lg font-semibold tabular-nums leading-tight">{fmtPrice(pick.quote.price)}</div>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 rounded-xl bg-surface-2 px-3 py-2">
                    <div>
                      <div className="text-xs text-muted">{estimate ? "预估价" : "买入价"}</div>
                      <div className="font-medium tabular-nums">{fmtPrice(pick.buy)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">{estimate ? "预计卖出" : "卖出价"}</div>
                      <div className="font-medium tabular-nums">{fmtPrice(pick.sell)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">{estimate ? "预计止损" : "止损价"}</div>
                      <div className="font-medium tabular-nums">{fmtPrice(pick.stop)}</div>
                    </div>
                  </div>
                  {pick.reasons[0] ? <p className="mt-2 text-xs text-pretty leading-5 text-muted">{pick.reasons.join("。")}</p> : null}
                </button>
              </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">等待卖出信号的股票池 共 {open.length}/{MAX_POSITIONS} 只</h2>
          <p className="mt-1 text-sm text-muted">
            只记上面这份名单里、连续竞价打到买入价的。买入当天不能卖。跌停封死的那天卖不出，顺延。已持仓若同时止损，大约亏掉这套仓位的 {risk == null ? "—" : signedPct(-risk * 100)}。空着的名额不算。
          </p>
        </div>
        {open.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {ready && !onServer ? "还没有打到买入价的股票。" : onServer ? "服务器还没有打到买入价的股票。" : "正在读取记录。"}
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
                        <span className={"rounded-full px-2 py-0.5 text-xs font-normal " + (trade.day >= date ? "bg-surface-2 text-muted" : trade.live && limitTag(trade.live) === "跌停" ? "bg-surface-2 text-muted" : trade.live && (trade.live.price <= levels(trade, rules).stop || trade.live.price >= levels(trade, rules).target) ? "bg-up text-bg" : "bg-down-soft text-down")}>
                          {trade.day >= date ? "T+1" : trade.live && limitTag(trade.live) === "跌停" ? "跌停卖不出" : trade.live && trade.live.price <= levels(trade, rules).stop ? "止损" : trade.live && trade.live.price >= levels(trade, rules).target ? "卖出" : "持有"}
                        </span>{" "}
                        <span className="font-normal text-muted">({trade.code})</span>
                        {STYLES.some(
                          (item) =>
                            item.id !== style &&
                            source.some((day) =>
                              day.trades.some((row) => row.exit == null && row.id === trade.id && styleOf(row) === item.id),
                            ),
                        )
                          ? " · 另有其他策略持有"
                          : ""}
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        买入 {trade.day} {trade.signalTime} · 买入价 {fmtPrice(trade.entry)} · 止损 {fmtPrice(levels(trade, rules).stop)} · 卖出 {fmtPrice(levels(trade, rules).target)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={toneClass(trade.ret == null ? null : trade.ret * 100) + " text-lg font-semibold tabular-nums"}>
                        {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                      </div>
                      <div className="text-xs text-muted">买入以来</div>
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
          <h2 className="font-serif text-lg font-semibold">这套策略的历史信号</h2>
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
