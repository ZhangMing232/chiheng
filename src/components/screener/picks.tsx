/**
 * 这个文件是干什么的：
 * 选股页的主体。上面换五套策略，中间是今天的精选表，下面是还拿着的股票池。
 * 点名称打开详情，历史成绩折在最底下，也可以生成一张汇总图。
 *
 * 你需要知道的：
 * 这里只展示。打到买入价才进股票池，当天不能卖。生成图片不会改变买入价。
 */

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PosterButton } from "@/components/screener/poster-button";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { drawPicksPoster } from "@/lib/market/page-posters";
import { nowAction } from "@/lib/market/action";
import { MAX_POSITIONS, STYLES, styleOf } from "@/lib/market/strategies";
import { TRACK_NEED, limitTag, planExit } from "@/lib/market/model";
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

function pickBadge(pick: Pick, open: { id: string }[], preview: boolean, todayTaken: number): string {
  const tracked = open.some((trade) => trade.id === pick.quote.id);
  const estimate = preview && !tracked;
  if (tracked) return "追踪中";
  if (pick.hit && todayTaken >= MAX_POSITIONS) return "已满";
  if (pick.block === "limit") return "涨停买不进";
  if (pick.block === "away") return "不追";
  if (estimate) return "尾盘再定";
  if (pick.hit) return "已到买入价";
  return "等待买入";
}

/** 画出策略切换、今天的精选、还在拿的股票池，以及折起来的历史成绩。 */
export function Picks({
  date,
  picks,
  quotes,
  serverDays,
  personal,
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
  personal: boolean;
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
  const source = personal || serverDays.length > 0 ? serverDays : browserDays;
  // 名额是按「天」算的：昨天进的那批占昨天的名额，不影响今天。
  // 所以标签上的数字和「仓位已满」都只看当天建了几只，
  // 账上还拿着几只（含前几天没卖出的）单独统计。
  const todayTrades = source.filter((day) => day.date === date).flatMap((day) => day.trades);
  const books = STYLES.map((item) => ({
    id: item.id,
    name: item.name,
    n: todayTrades.filter((trade) => styleOf(trade) === item.id).length,
  }));
  const todayTaken = todayTrades.filter((trade) => styleOf(trade) === style).length;
  const days = source
    .map((day) => ({ ...day, trades: day.trades.filter((trade) => styleOf(trade) === style) }))
    .filter((day) => day.trades.length > 0);
  const onServer = personal || serverDays.length > 0;
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
      <div className="flex gap-5 overflow-x-auto scroll-slim border-b border-line">
        {books.map((book) => (
          <button
            key={book.id}
            type="button"
            onClick={() => onStyle(book.id)}
            className={"shrink-0 border-b-2 pb-2 text-sm " + (book.id === style ? "-mb-px border-brand font-medium text-brand" : "border-transparent text-muted")}
          >
            {book.name}
            <span className="ml-1 tabular-nums">{book.n}</span>
          </button>
        ))}
      </div>
      <p className="text-sm text-pretty">
        <span className="font-medium">{now.title}</span>
        <span className="text-muted"> {now.body}</span>
      </p>
      <p className="text-xs text-muted">{STYLES.find((item) => item.id === style)?.hint}</p>
      <PosterButton
        draw={() =>
          drawPicksPoster({
            date,
            styleName: STYLES.find((item) => item.id === style)?.name ?? "选股",
            openCount: open.filter((trade) => styleOf(trade) === style).length,
            rows: featured.map((pick) => ({
              name: pick.quote.name,
              code: pick.quote.code,
              chg: pick.quote.chg,
              price: pick.quote.price,
              buy: pick.buy,
              sell: pick.sell,
              badge: pickBadge(pick, open, preview, todayTaken),
            })),
          })
        }
      />
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex items-baseline justify-between gap-3 px-4 py-3">
          <h2 className="text-base font-semibold">精选 {featured.length}</h2>
          <span className="text-xs text-muted">
            {dayLabel(date)} · {preview ? "14:30 前是预览" : style === "relay" ? "14:30 已冻结" : "打到买入价才追踪"}
          </span>
        </div>
        {featured.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {style === "relay" ? "今天没有三个够强的概念板块，或者次强已经贴着涨停、买不进。" : "这套策略现在没有符合的股票。"}
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="sticky left-0 bg-surface px-4 py-2 text-left font-normal">名称</th>
                  <th className="px-3 py-2 text-right font-normal">现价</th>
                  <th className="px-3 py-2 text-right font-normal">{preview ? "预估买入" : "买入"}</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">{preview ? "预估卖出" : "卖出"}</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">{preview ? "预估止损" : "止损"}</th>
                </tr>
              </thead>
              <tbody>
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
                    : pick.hit && todayTaken >= MAX_POSITIONS
                      ? "已满"
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
                    <tr key={pick.quote.id} className="border-b border-line last:border-0">
                      <td className="sticky left-0 bg-surface px-4 py-2.5">
                        <button type="button" onClick={() => onOpen(pick.quote.id)} className="block max-w-48 text-left">
                          <div className="truncate font-medium">{pick.quote.name}</div>
                          <div className="truncate text-xs text-muted">
                            {pick.quote.code} ·{" "}
                            <span className={badge === "已到买入价" || badge === "追踪中" ? "font-medium text-brand" : ""}>{badge}</span>
                            {elsewhere.length > 0 ? ` · ${elsewhere.join("、")}` : ""}
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" onClick={() => onOpen(pick.quote.id)} className="block w-full text-right">
                          <div className="font-medium tabular-nums">{fmtPrice(pick.quote.price)}</div>
                          <div className={toneClass(pick.quote.chg) + " text-xs tabular-nums"}>{signedPct(pick.quote.chg)}</div>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtPrice(pick.buy)}</td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{fmtPrice(pick.sell)}</td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{fmtPrice(pick.stop)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-surface shadow-card">
        <div className="px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">
            今日建仓 <span className="text-brand tabular-nums">{todayTaken}</span>
            <span className="text-muted tabular-nums">/{MAX_POSITIONS}</span>
          </h2>
          <p className="mt-1 text-xs text-muted">名额按天算，每天最多 {MAX_POSITIONS} 只。打到买入价才记，当天不能卖，跌停卖不出就顺延。当前持有 {open.length} 只。</p>
        </div>
        {open.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {ready && !onServer ? "还没有打到买入价的股票。" : onServer ? "服务器还没有打到买入价的股票。" : "正在读取记录。"}
          </p>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="sticky left-0 bg-surface px-4 py-2 text-left font-normal">名称</th>
                  <th className="px-3 py-2 text-right font-normal">现价</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">今日</th>
                  <th className="px-3 py-2 text-right font-normal">买入以来</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">买入价</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">卖出</th>
                  <th className="hidden px-3 py-2 text-right font-normal md:table-cell">止损</th>
                </tr>
              </thead>
              <tbody>
                {open.map((trade) => {
                  const state = trade.day >= date ? "T+1" : trade.live && limitTag(trade.live) === "跌停" ? "跌停" : trade.live && trade.live.price <= levels(trade, rules).stop ? "止损" : trade.live && trade.live.price >= levels(trade, rules).target ? "卖出" : "持有";
                  return (
                    <tr key={`${trade.day}-${trade.id}`} className="border-b border-line last:border-0">
                      <td className="sticky left-0 bg-surface px-4 py-2.5">
                        <Link to="/symbol" search={{ q: trade.code }} className="font-medium">
                          {trade.name}
                        </Link>
                        <button type="button" onClick={() => onOpen(trade.id)} className="block text-left text-xs text-muted">
                          {trade.code} · {state}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                        <div>{trade.live ? fmtPrice(trade.live.price) : "—"}</div>
                        <div className={toneClass(trade.live?.chg) + " text-xs md:hidden"}>{signedPct(trade.live?.chg)}</div>
                      </td>
                      <td className={toneClass(trade.live?.chg) + " hidden px-3 py-2.5 text-right tabular-nums md:table-cell"}>{signedPct(trade.live?.chg)}</td>
                      <td className={toneClass(trade.ret == null ? null : trade.ret * 100) + " px-3 py-2.5 text-right tabular-nums"}>
                        {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{fmtPrice(trade.entry)}</td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{fmtPrice(levels(trade, rules).target)}</td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums md:table-cell">{fmtPrice(levels(trade, rules).stop)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="rounded-xl border border-line bg-surface">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold">历史</span>
          <span className="text-sm tabular-nums text-muted">
            {closed.length === 0 ? "还没有卖出" : `上涨 ${((wins / closed.length) * 100).toFixed(2)}% · ${days.length} 天`}
          </span>
        </summary>
        <div className="grid grid-cols-4 border-t border-line">
          <div className="px-4 py-3">
            <div className="text-xs text-muted">上涨占比</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{closed.length === 0 ? "—" : `${((wins / closed.length) * 100).toFixed(2)}%`}</div>
          </div>
          <div className="border-l border-line px-4 py-3">
            <div className="text-xs text-muted">累计收益</div>
            <div className={"mt-1 text-lg font-semibold tabular-nums " + toneClass(closed.length ? cum * 100 : null)}>
              {closed.length === 0 ? "—" : signedPct(cum * 100)}
            </div>
          </div>
          <div className="border-l border-line px-4 py-3">
            <div className="text-xs text-muted">最大回撤</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{ordered.length === 0 ? "—" : signedPct(-maxDrawdown(ordered) * 100)}</div>
          </div>
          <div className="border-l border-line px-4 py-3">
            <div className="text-xs text-muted">沪深300</div>
            <div className={"mt-1 text-lg font-semibold tabular-nums " + toneClass(indexCum == null ? null : indexCum * 100)}>
              {indexCum == null ? "—" : signedPct(indexCum * 100)}
            </div>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-pretty text-muted">
          卖出看目标价，不看 60 天。{gate.reason}。累计收益是每笔扣费后收益相加。不满 {TRACK_NEED} 个交易日时，上涨占比还只是样本。
        </p>
        {closed.length === 0 ? null : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">买入价</th>
                  <th className="px-3 py-2 font-medium">卖出价</th>
                  <th className="px-4 py-2 text-right font-medium">收益率</th>
                </tr>
              </thead>
              <tbody>
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
                      <div className="text-xs text-muted">成交 {trade.exitDate?.slice(5)}</div>
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
      </details>
    </div>
  );
}
