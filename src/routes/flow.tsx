import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { getFlow } from "@/lib/market/quotes.functions";
import type { FlowRow, MarketPart, NorthLeg } from "@/lib/market/flow";

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

function Market({ parts }: { parts: MarketPart[] }) {
  const sum = (key: keyof Omit<MarketPart, "name">) => parts.reduce((total, part) => total + part[key], 0);
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
      <div className="px-4 py-3">
        <h2 className="text-base font-semibold">大盘资金</h2>
        <p className="mt-1 text-sm text-muted">上证指数加深证成指的今日净流入。主力是超大单加大单，单笔不少于 20 万或 6 万股。不是全市场逐只相加。</p>
      </div>
      {parts.length === 0 ? (
        <p className="border-t border-line px-4 py-6 text-sm text-muted">大盘资金暂时拉不下来。</p>
      ) : (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left">
            <thead className="text-sm text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">成分</th>
                <th className="px-4 py-2 text-right font-normal">合计</th>
                {parts.map((part) => (
                  <th key={part.name} className="px-4 py-2 text-right font-normal">
                    {part.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-line">
                  <td className="px-4 py-2">{row.name}</td>
                  <td className={toneClass(sum(row.key)) + " px-4 py-2 text-right tabular-nums"}>{fmtWan(sum(row.key))}</td>
                  {parts.map((part) => (
                    <td key={part.name} className={toneClass(part[row.key]) + " px-4 py-2 text-right tabular-nums"}>
                      {fmtWan(part[row.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

function FlowPage() {
  const { book, error } = Route.useLoaderData();
  return (
    <Frame>
        <p className="text-sm text-muted">主力净流入大约一分钟更新。北向没有盘中净流入。红是净流入，绿是净流出。不改变买入价。</p>
        {error ? <p className="text-sm text-up">{error}</p> : null}
        {book ? (
          <>
            <Market parts={book.market} />
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
