import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { drawFlowPoster } from "@/lib/market/flow-poster";
import { getFlow, getHotMoney, getIndexFutures } from "@/lib/market/quotes.functions";
import { drawFuturesPoster, drawHotPoster } from "@/lib/market/extra-posters";
import { readMarket, type FlowRow, type MarketPart, type MarketTape, type NorthLeg } from "@/lib/market/flow";
import type { HotBook, HotSeat } from "@/lib/market/hotmoney";
import type { FutBook } from "@/lib/market/index-futures";

export const Route = createFileRoute("/flow")({
  loader: async () => {
    const [book, hot, futures] = await Promise.all([
      getFlow().catch((error: unknown) => ({ error })),
      getHotMoney().catch(() => null),
      getIndexFutures().catch(() => null),
    ]);
    if (book && typeof book === "object" && "error" in book) {
      return {
        book: null,
        hot: null as HotBook | null,
        futures: null as FutBook | null,
        error: book.error instanceof Error ? book.error.message : "资金流向暂时拉不下来",
      };
    }
    return { book, hot, futures, error: null as string | null };
  },
  component: FlowPage,
});

function List({ title, rows, hint }: { title: string; rows: FlowRow[]; hint?: string }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <div className="px-4 py-3">
        <h2 className="font-serif text-lg font-semibold">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">没有数据。</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 border-t border-line px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{row.name}</div>
                <div className="mt-0.5 text-xs text-muted">
                  <span className={toneClass(row.chg)}>{signedPct(row.chg)}</span>
                  {row.leader ? ` · 领涨 ${row.leader}` : null}
                </div>
              </div>
              <div className={toneClass(row.inflow) + " shrink-0 text-right font-medium tabular-nums"}>{fmtWan(row.inflow)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function North({ legs }: { legs: NorthLeg[] }) {
  const total = legs.reduce((sum, leg) => sum + leg.amount, 0);
  return (
    <section className="rounded-2xl border border-line bg-surface px-4 py-3">
      <h2 className="font-serif text-lg font-semibold">北向</h2>
      <p className="mt-1 text-sm text-muted">沪股通和深股通的盘中净流入不再公布，收盘后也没有净买入。这里只有最近一个已公布交易日的成交额。</p>
      {legs.length === 0 ? (
        <p className="mt-3 text-sm text-muted">北向成交额暂时拉不下来。</p>
      ) : (
        <ul className="mt-3">
          {legs.map((leg) => (
            <li key={leg.name} className="flex items-baseline justify-between gap-3 border-t border-line py-2 first:border-t-0">
              <div>
                <div className="font-medium">{leg.name}</div>
                <div className="text-xs text-muted">
                  {leg.date}
                  {leg.leader ? ` · 成交居前 ${leg.leader}` : ""}
                </div>
              </div>
              <div className="shrink-0 font-medium tabular-nums">{fmtWan(leg.amount)}</div>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 border-t border-line py-2">
            <div className="font-medium">合计成交额</div>
            <div className="font-medium tabular-nums">{fmtWan(total)}</div>
          </li>
        </ul>
      )}
    </section>
  );
}

function flowWord(value: number): string {
  if (value > 0) return "净流入";
  if (value < 0) return "净流出";
  return "持平";
}

function Market({ parts, tape }: { parts: MarketPart[]; tape: MarketTape[] }) {
  const sum = (key: keyof Omit<MarketPart, "name">) => parts.reduce((total, part) => total + part[key], 0);
  const amount = tape.reduce((total, row) => total + row.amount, 0);
  const prevAmount = tape.every((row) => row.prevAmount != null) ? tape.reduce((total, row) => total + (row.prevAmount ?? 0), 0) : null;
  const amountDelta = prevAmount == null ? null : amount - prevAmount;
  const volumeWord = amountDelta == null ? null : amountDelta > 0 ? "放量" : amountDelta < 0 ? "缩量" : "持平";
  const main = parts.length > 0 ? sum("main") : null;
  const share = amount > 0 && main != null ? (main / amount) * 100 : null;
  const rows: { name: string; key: keyof Omit<MarketPart, "name"> }[] = [
    { name: "主力", key: "main" },
    { name: "超大单", key: "super" },
    { name: "大单", key: "big" },
    { name: "中单", key: "mid" },
    { name: "小单", key: "small" },
    { name: "散户", key: "retail" },
  ];
  return (
    <section className="rounded-2xl border border-line bg-surface">
        <h2 className="px-4 pt-3 text-base font-semibold">大盘</h2>
        <div className="grid grid-cols-3 gap-px border-b border-line bg-line">
          <div className="bg-surface px-4 py-4">
            <div className="text-xs text-muted">成交额</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums leading-none">{amount > 0 ? fmtWan(amount) : "—"}</div>
            <div className="mt-2 text-xs text-muted">
              {tape.map((row) => `${row.name} ${fmtWan(row.amount)}`).join(" · ") || "上证和深成"}
            </div>
          </div>
          <div className="bg-surface px-4 py-4">
            <div className={"text-xs " + (amountDelta == null || amountDelta === 0 ? "text-muted" : amountDelta > 0 ? "text-up" : "text-down")}>
              {volumeWord ?? "较昨日"}
            </div>
            <div className={(amountDelta == null || amountDelta === 0 ? "text-fg" : amountDelta > 0 ? "text-up" : "text-down") + " mt-1 text-2xl font-semibold tabular-nums leading-none"}>
              {amountDelta == null ? "—" : fmtWan(Math.abs(amountDelta))}
            </div>
            <div className="mt-2 text-xs text-muted">比上一交易日</div>
          </div>
          <div className="bg-surface px-4 py-4">
            <div className="text-xs text-muted">{main == null ? "主力" : `主力${flowWord(main)}`}</div>
            <div className={toneClass(main) + " mt-1 text-2xl font-semibold tabular-nums leading-none"}>{main == null ? "—" : fmtWan(main)}</div>
            <div className="mt-2 text-xs text-muted">{share == null ? "占成交额 —" : `占成交额 ${Math.abs(share).toFixed(2)}%`}</div>
          </div>
        </div>
      {parts.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">大盘资金暂时拉不下来。</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">成分</th>
                <th className="px-4 py-2 text-right font-normal">合计净流入</th>
                {parts.map((part) => (
                  <th key={part.name} className="px-4 py-2 text-right font-normal">
                    {part.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={"border-t border-line " + (row.key === "main" || row.key === "retail" ? "font-medium" : "text-muted")}>
                  <td className="px-4 py-2">{row.name}</td>
                  <td className={toneClass(sum(row.key)) + " px-4 py-2 text-right tabular-nums"}>
                    {flowWord(sum(row.key))} {fmtWan(sum(row.key))}
                  </td>
                  {parts.map((part) => (
                    <td key={part.name} className={toneClass(part[row.key]) + " px-4 py-2 text-right tabular-nums"}>
                      {flowWord(part[row.key])} {fmtWan(part[row.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parts.length > 0 ? (
        <ul className="border-t border-line px-4 py-3 text-sm text-muted">
          {readMarket(parts).map((line) => (
            <li key={line} className="py-1 text-pretty">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="border-t border-line px-4 py-3">
        <h3 className="text-sm font-semibold">另外三类</h3>
        <ul className="mt-2 text-sm">
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>机构</span>
            <span className="text-right text-muted">没有全市场席位净额。主力不是机构。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>外资</span>
            <span className="text-right text-muted">北向净买入不公布，下面只有成交额。</span>
          </li>
          <li className="flex justify-between gap-3 border-t border-line py-2">
            <span>国家队</span>
            <span className="text-right text-muted">汇金、证金没有盘中净流入。</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

function seatLine(seat: HotSeat) {
  const word = seat.netWan > 0 ? "净买" : "净卖";
  const stocks = seat.stocks
    .map((stock) => `${stock.name} ${stock.netWan > 0 ? "净买" : "净卖"}${fmtWan(stock.netWan)}`)
    .join(" · ");
  return { word, stocks };
}

function Hot({ book }: { book: HotBook | null }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <div className="px-4 py-3">
        <h2 className="text-base font-semibold">游资</h2>
        <p className="mt-1 text-xs text-muted">龙虎榜营业部的买入和卖出。机构席位、沪股通、深股通不放这里。收盘后才有。{book?.date ? ` ${book.date}` : ""}</p>
      </div>
      {!book || (book.buys.length === 0 && book.sells.length === 0) ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">游资龙虎榜暂时没有。</p>
      ) : (
        <div className="grid border-t border-line md:grid-cols-2 md:divide-x md:divide-line">
          <SeatList title="净买入" seats={book.buys} />
          <SeatList title="净卖出" seats={book.sells} />
        </div>
      )}
    </section>
  );
}

function SeatList({ title, seats }: { title: string; seats: HotSeat[] }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul>
        {seats.map((seat) => {
          const line = seatLine(seat);
          return (
            <li key={seat.name} className="border-t border-line py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{seat.name}</span>
                <span className={toneClass(seat.netWan) + " shrink-0 tabular-nums"}>
                  {line.word} {fmtWan(seat.netWan)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">{line.stocks}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function lotsText(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}万手`;
  return `${Math.round(abs)}手`;
}

function Futures({ book }: { book: FutBook | null }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <div className="px-4 py-3">
        <h2 className="text-base font-semibold">股指期货</h2>
        <p className="mt-1 text-xs text-muted">中金所前20名会员的多单和空单。公布的是代客，不是单独的机构账户。{book?.date ? ` ${book.date}` : ""}</p>
      </div>
      {!book || book.rows.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">股指期货持仓暂时没有。</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">合约</th>
                <th className="px-3 py-2 text-right font-normal">多单</th>
                <th className="px-3 py-2 text-right font-normal">空单</th>
                <th className="px-4 py-2 text-right font-normal">净持仓</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map((row) => {
                const net = row.longLots - row.shortLots;
                return (
                  <tr key={row.contract} className="border-t border-line">
                    <td className="px-4 py-2">
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted">{row.contract}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-up">{lotsText(row.longLots)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-down">{lotsText(row.shortLots)}</td>
                    <td className={toneClass(net) + " px-4 py-2 text-right tabular-nums"}>
                      {net > 0 ? "净多" : net < 0 ? "净空" : "持平"} {lotsText(net)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FlowPage() {
  const { book, hot, futures, error } = Route.useLoaderData();

  return (
    <Frame>
        <p className="text-sm text-muted">主力净流入大约一分钟更新。北向没有盘中净流入。红是净流入，绿是净流出。不改变买入价。</p>
        {error ? <p className="text-sm text-up">{error}</p> : null}
        {book ? (
          <>
            <PosterButton draw={() => drawFlowPoster(book)} />
            <Market parts={book.market} tape={book.tape} />
            <North legs={book.north} />
            <List title="行业净流入" rows={book.sectorsIn} />
            <List title="行业净流出" rows={book.sectorsOut} />
            <List title="个股净流入" rows={book.stocksIn} hint="已去掉新股和 ST。" />
            <List title="个股净流出" rows={book.stocksOut} hint="已去掉新股和 ST。" />
          </>
        ) : null}
        <PosterButton draw={() => drawHotPoster(hot ?? { date: "", buys: [], sells: [] })} />
        <Hot book={hot} />
        <PosterButton draw={() => drawFuturesPoster(futures ?? { date: "", rows: [] })} />
        <Futures book={futures} />
      </Frame>
  );
}
