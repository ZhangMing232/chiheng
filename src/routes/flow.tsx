import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { getFlow } from "@/lib/market/quotes.functions";
import type { FlowRow, NorthLeg } from "@/lib/market/flow";

export const Route = createFileRoute("/flow")({
  loader: async () => {
    try {
      return { book: await getFlow(), error: null as string | null };
    } catch (error) {
      return { book: null, error: error instanceof Error ? error.message : "资金流向暂时拉不下来" };
    }
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

function FlowPage() {
  const { book, error } = Route.useLoaderData();
  return (
    <Frame>
        <p className="text-sm text-muted">主力净流入大约一分钟更新。北向没有盘中净流入。红是净流入，绿是净流出。不改变买入价。</p>
        {error ? <p className="text-sm text-up">{error}</p> : null}
        {book ? (
          <>
            <North legs={book.north} />
            <List title="行业净流入" rows={book.sectorsIn} />
            <List title="行业净流出" rows={book.sectorsOut} />
            <List title="个股净流入" rows={book.stocksIn} hint="已去掉新股和 ST。" />
            <List title="个股净流出" rows={book.stocksOut} hint="已去掉新股和 ST。" />
          </>
        ) : null}
      </Frame>
  );
}
