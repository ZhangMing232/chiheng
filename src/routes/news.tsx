import { createFileRoute } from "@tanstack/react-router";
import { TopNav } from "@/components/screener/nav";
import { signedPct, toneClass } from "@/lib/market/format";
import { watchList, type StyleId } from "@/lib/market/strategies";
import { getNews, getRelay, getRules, getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import { DEFAULT_RULES } from "@/lib/market/rules";
import type { NewsItem } from "@/lib/market/news";

const WATCH: StyleId[] = ["early", "trend", "breakout", "value"];

export const Route = createFileRoute("/news")({
  loader: async () => {
    const [news, universe, journal, rules] = await Promise.all([
      getNews().catch(() => [] as NewsItem[]),
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getServerJournal().catch(() => ({ days: [] })),
      getRules().catch(() => DEFAULT_RULES),
    ]);
    const relay = await getRelay().catch(() => []);
    const held = new Set<string>();
    for (const day of journal.days) {
      for (const trade of day.trades) {
        if (trade.exit == null) held.add(trade.id);
      }
    }
    const picked = new Set<string>();
    if (universe) {
      for (const style of WATCH) {
        for (const row of watchList(universe.quotes, style, rules, () => true)) picked.add(row.quote.id);
      }
    }
    for (const row of relay) picked.add(row.quote.id);
    for (const id of held) picked.delete(id);
    return { news, held: [...held], picked: [...picked], failed: news.length === 0 };
  },
  component: NewsPage,
});

function NewsPage() {
  const { news, held, picked, failed } = Route.useLoaderData();
  const heldSet = new Set(held);
  const pickedSet = new Set(picked);
  const rank = (item: NewsItem) => (item.stocks.some((stock) => heldSet.has(stock.id)) ? 0 : item.stocks.some((stock) => pickedSet.has(stock.id)) ? 1 : 2);
  const ordered = [...news].sort((a, b) => rank(a) - rank(b));
  const focus = new Map<string, { name: string; code: string; chg: number | null; mark: "持仓" | "精选"; title: string }>();
  for (const item of news) {
    for (const stock of item.stocks) {
      const mark = heldSet.has(stock.id) ? "持仓" : pickedSet.has(stock.id) ? "精选" : null;
      if (!mark || focus.has(stock.id)) continue;
      focus.set(stock.id, { name: stock.name, code: stock.code, chg: stock.chg, mark, title: item.title });
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 py-3 md:px-6">
          <h1 className="font-serif text-2xl leading-none font-semibold tracking-tight">赤衡</h1>
          <TopNav />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
        <section className="rounded-2xl border border-line border-l-4 border-l-[#5ad7ff] bg-surface px-4 py-3 shadow-card">
          <h2 className="font-serif text-lg font-semibold">重点提示</h2>
          <p className="mt-1 text-sm text-muted">快讯里提到、又在持仓或五套精选里的股票。消息不改变买入价，也不当作买卖理由。</p>
          {focus.size === 0 ? (
            <p className="mt-3 text-sm text-muted">{failed ? "消息暂时拉不下来。" : "这批快讯里没有持仓或精选。"}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {[...focus.values()].map((stock) => (
                <li key={stock.code} className="rounded-xl bg-surface-2 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate font-medium">
                      {stock.name}
                      <span className="ml-2 text-xs font-normal text-muted">{stock.code}</span>
                      <span className={"ml-2 rounded-full px-2 py-0.5 text-xs font-normal " + (stock.mark === "持仓" ? "bg-up-soft text-up" : "bg-[#123044] text-[#5ad7ff]")}>
                        {stock.mark}
                      </span>
                    </div>
                    <div className={toneClass(stock.chg) + " shrink-0 text-sm tabular-nums"}>{signedPct(stock.chg)}</div>
                  </div>
                  <p className="mt-1 text-xs text-pretty text-muted">{stock.title}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-2xl border border-line bg-surface shadow-card">
          <div className="px-4 py-3">
            <h2 className="font-serif text-lg font-semibold">7x24</h2>
            <p className="mt-1 text-xs text-muted">东方财富快讯。有个股的排在前面。</p>
          </div>
          {ordered.length === 0 ? (
            <p className="border-t border-line px-4 py-6 text-sm text-muted">没有拉到快讯。</p>
          ) : (
            <ul>
              {ordered.map((item) => {
                const hot = rank(item) < 2;
                return (
                  <li key={item.id} className={"border-t border-line px-4 py-3 " + (hot ? "border-l-2 border-l-[#5ad7ff]" : "")}>
                    <div className="text-xs tabular-nums text-muted">{item.time.slice(5, 16)}</div>
                    <h3 className="mt-1 text-sm font-medium text-pretty">{item.title}</h3>
                    {item.summary && item.summary !== item.title ? (
                      <p className="mt-1 line-clamp-3 text-xs text-pretty leading-5 text-muted">{item.summary}</p>
                    ) : null}
                    {item.stocks.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.stocks.map((stock) => {
                          const mark = heldSet.has(stock.id) ? "持仓" : pickedSet.has(stock.id) ? "精选" : "";
                          return (
                            <span key={stock.id} className={"rounded-full px-2 py-0.5 text-xs " + (mark === "持仓" ? "bg-up-soft text-up" : mark === "精选" ? "bg-[#123044] text-[#5ad7ff]" : "bg-surface-2 text-muted")}>
                              {stock.name} {signedPct(stock.chg)}
                              {mark ? ` ${mark}` : ""}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
