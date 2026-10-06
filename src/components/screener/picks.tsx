/**
 * 这个文件是干什么的：
 * 选股页的主体。上面换五套策略，中间是今天的精选表，下面是还拿着的股票池。
 * 点名称打开详情，历史成绩折在最底下，也可以生成一张汇总图。
 *
 * 你需要知道的：
 * 这里只展示。打到买入价才进股票池，当天不能卖。生成图片不会改变买入价。
 */

import { Link } from "@tanstack/react-router";
import { PosterButton } from "@/components/screener/poster-button";
import { fmtPrice, signedPct } from "@/lib/market/format";
import { drawPicksPoster } from "@/lib/market/page-posters";
import { nowAction } from "@/lib/market/action";
import { MAX_POSITIONS, STYLES, styleOf } from "@/lib/market/strategies";
import { limitTag, planExit } from "@/lib/market/model";
import type { EarlyRules } from "@/lib/market/rules";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperDay } from "@/lib/paper";
import { StateBlock } from "@/components/state-block";
import { Panel, Table, Tag, pctClass, tdClass, thClass } from "@/components/terminal";

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
  style: "early" | "trend" | "breakout" | "value" | "relay" | "rebound";
  benchmark: { name: string; price: number; pct: number } | null;
  marketOpen: boolean;
  tailHalf: boolean;
  pause: string;
  onStyle: (style: "early" | "trend" | "breakout" | "value" | "relay" | "rebound") => void;
  onOpen: (id: string) => void;
}) {
  const browserDays = usePaper((state) => state.days);
  const source = personal || serverDays.length > 0 ? serverDays : browserDays;
  // 名额是按「天」算的：昨天进的那批占昨天的名额，不影响今天。
  // 所以标签上的数字和「仓位已满」都只看当天建了几只，
  // 账上还拿着几只（含前几天没卖出的）单独统计。
  const todayTrades = source.filter((day) => day.date === date).flatMap((day) => day.trades);
  const styleLabel = STYLES.find((item) => item.id === style)?.name ?? style;
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
  const featured = picks;
  const preview = style === "relay" && !tailHalf;
  // 主源降级时，新浪那份名单里没有近 5/20/60 日涨幅、量比也是 0。
  // 这时放量突破和中期反转一只都进不来，页面会显示「没有符合的股票」——那是假的，
  // 真正的原因是源缺字段。这里直接查手上的行情有没有这些字段，说清楚。
  const lacking =
    quotes.length > 0 && quotes.every((quote) => quote.d60 == null)
      ? style === "rebound"
        ? "60 日涨幅"
        : style === "breakout"
          ? "5/20 日涨幅和量比"
          : null
      : null;
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
      {/* 策略切换。和顶栏页签同一套：选中项 surface-2 垫底，不再用红线红字 */}
      <div className="flex gap-0.5 overflow-x-auto scroll-slim">
        {books.map((book) => (
          <button
            key={book.id}
            type="button"
            onClick={() => onStyle(book.id)}
            aria-pressed={book.id === style}
            className={
              "nav-tab inline-flex shrink-0 items-center rounded text-sm " +
              (book.id === style ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")
            }
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
      <Panel
        title={<span>精选 <span className="text-muted tabular-nums">{featured.length}</span></span>}
        note={
          <span>
            {dayLabel(date)} ·{" "}
            {preview
              ? "14:30 前是预览"
              : style === "relay"
                ? "14:30 已冻结"
                : style === "rebound"
                  ? "按现价买，拿满 10 个交易日"
                  : "打到买入价才追踪"}
          </span>
        }
      >
        {featured.length === 0 ? (
          <StateBlock
            kind="empty"
            title={
              lacking
                ? "不是选不出票，是行情源缺字段"
                : style === "relay"
                  ? "今天尾盘没有可买的接力票"
                  : "今天这套没有符合条件的票"
            }
            hint={
              lacking
                ? `现在这份行情没有${lacking}，这套策略一条都进不来。等主源恢复自动切回，或点上面「重新拉一次」。`
                : style === "relay"
                  ? "要当天最强的三个概念板块都够强、且次强没贴着涨停。今天没有满足的组合，明天再看。"
                  : "门槛是固定的（见策略说明），没出现就是没出现，不是坏了。可以点上面「重新拉一次」确认不是数据没更新。"
            }
          />
        ) : (
          <Table className="data-table" caption={`${styleLabel} 今天符合条件的 ${picks.length} 只票`}>
            <thead>
              <tr className="border-b border-line">
                <th className={thClass("sticky left-0 bg-surface px-2.5 py-1.5 text-left font-normal")}>名称</th>
                <th className={thClass()}>现价</th>
                <th className={thClass()}>{preview ? "预估买入" : "买入"}</th>
                <th className={thClass("hidden md:table-cell")}>{preview ? "预估卖出" : "卖出"}</th>
                <th className={thClass("hidden md:table-cell")}>{preview ? "预估止损" : "止损"}</th>
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
                  <tr key={pick.quote.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td data-l="名称" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
                      <button type="button" onClick={() => onOpen(pick.quote.id)} className="block max-w-48 text-left">
                        <div className="truncate font-medium">{pick.quote.name}</div>
                        <div className="truncate text-xs text-muted">
                          {pick.quote.code} ·{" "}
                          <Tag tone={badge === "已到买入价" || badge === "追踪中" ? "brand" : "muted"}>{badge}</Tag>
                          {elsewhere.length > 0 ? ` ${elsewhere.join("、")}` : ""}
                        </div>
                      </button>
                    </td>
                    <td data-l="现价 / 涨跌幅" className={tdClass("font-medium")}>
                      <div>{fmtPrice(pick.quote.price)}</div>
                      <div className={pctClass(pick.quote.chg)}>{signedPct(pick.quote.chg)}</div>
                    </td>
                    <td data-l="买入" className={tdClass()}>{fmtPrice(pick.buy)}</td>
                    <td data-l="卖出" data-opt className={tdClass("hidden md:table-cell")}>{fmtPrice(pick.sell)}</td>
                    <td data-l="止损" data-opt className={tdClass("hidden md:table-cell")}>{fmtPrice(pick.stop)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      {/* 持仓和历史战绩搬到 /positions 了。这里只留一条入口和当天的名额进度——
          盯盘时这两件事在第三个屏幕以下才看得到，够不着。 */}
      <Panel
        title={
          <span className="flex items-baseline gap-2">
            今日建仓
            <span className="tabular-nums">{todayTaken}</span>
            <span className="text-muted tabular-nums">/{MAX_POSITIONS}</span>
          </span>
        }
        note={
          <Link to="/positions" className="hover:text-fg hover:underline">
            当前持有 {open.length} 只 · 全部持仓 →
          </Link>
        }
        bodyClassName="px-3 py-2"
      >
        <p className="text-xs text-muted">
          名额按天算，每天最多 {MAX_POSITIONS} 只。打到买入价才记，当天不能卖，跌停卖不出就顺延。
          持有 {open.length} 只
          {onServer ? "" : "（本机浏览器的账）"}
        </p>
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-surface-2" role="img" aria-label={`今日建仓 ${todayTaken} / ${MAX_POSITIONS}`}>
          {/* 中性色的进度条：名额用没用完不是涨跌也不是警告，不需要颜色说话 */}
          <div
            className="h-full bg-fg"
            style={{ width: `${Math.min(100, (todayTaken / MAX_POSITIONS) * 100)}%` }}
          />
        </div>
      </Panel>
    </div>
  );
}
