import { createFileRoute } from "@tanstack/react-router";
import { TopNav } from "@/components/screener/nav";
import { fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { getFlow } from "@/lib/market/quotes.functions";
import type { FlowRow } from "@/lib/market/flow";

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
    <section className="rounded-2xl border border-line bg-surface shadow-card">
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

function FlowPage() {
  const { book, error } = Route.useLoaderData();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 py-3 md:px-6">
          <h1 className="font-serif text-2xl leading-none font-semibold tracking-tight">赤衡</h1>
          <TopNav />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
        <p className="text-sm text-muted">主力净流入，腾讯行情，大约一分钟更新。红是净流入，绿是净流出。不是逐笔，也不改变买入价。</p>
        {error ? <p className="text-sm text-up">{error}</p> : null}
        {book ? (
          <>
            <List title="行业净流入" rows={book.sectorsIn} />
            <List title="行业净流出" rows={book.sectorsOut} />
            <List title="个股净流入" rows={book.stocksIn} hint="已去掉新股和 ST。" />
            <List title="个股净流出" rows={book.stocksOut} hint="已去掉新股和 ST。" />
          </>
        ) : null}
      </main>
    </div>
  );
}
