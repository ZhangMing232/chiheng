import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { signedPct, toneClass } from "@/lib/market/format";
import { watchList, type StyleId } from "@/lib/market/strategies";
import { getNews, getRelay, getRules, getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import { DEFAULT_RULES } from "@/lib/market/rules";
import type { NewsItem, NewsTone } from "@/lib/market/news";

const WATCH: StyleId[] = ["early", "trend", "breakout", "value"];
const TONE_LABEL: Record<NewsTone, string> = { good: "利好", bad: "利空", flat: "未表态" };

function tally(items: NewsItem[], tone: NewsTone) {
  const boards = new Map<string, { name: string; n: number }>();
  const stocks = new Map<string, { id: string; name: string; code: string; chg: number | null; n: number; title: string }>();
  for (const item of items) {
    if (item.tone !== tone) continue;
    for (const board of item.boards) {
      const row = boards.get(board.code) ?? { name: board.name, n: 0 };
      row.n += 1;
      boards.set(board.code, row);
    }
    for (const stock of item.stocks) {
      const row = stocks.get(stock.id) ?? { id: stock.id, name: stock.name, code: stock.code, chg: stock.chg, n: 0, title: item.title };
      row.n += 1;
      stocks.set(stock.id, row);
    }
  }
  const byCount = (a: { n: number }, b: { n: number }) => b.n - a.n;
  return {
    boards: [...boards.entries()].map(([code, row]) => ({ code, ...row })).sort(byCount),
    stocks: [...stocks.values()].sort(byCount),
  };
}

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
  const good = tally(news, "good");
  const bad = tally(news, "bad");
  const rank = (item: NewsItem) => (item.tone === "good" ? 0 : item.tone === "bad" ? 1 : 2);
  const ordered = [...news].sort((a, b) => rank(a) - rank(b));

  return (
    <Frame>
        <section className="rounded-2xl border border-line bg-surface px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">利好</h2>
          <p className="mt-1 text-sm text-muted">按快讯用词归类，不是研报。点名的板块和个股列在下面。和持仓或精选重叠的会标出来。不改变买入价。</p>
          {good.boards.length === 0 && good.stocks.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{failed ? "消息暂时拉不下来。" : "这批快讯里没有判成利好的板块或个股。"}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <div className="text-xs text-muted">板块</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {good.boards.map((board) => (
                    <span key={board.code} className="rounded-full bg-up-soft px-2 py-0.5 text-xs text-up">
                      {board.name}
                      {board.n > 1 ? ` ${board.n}` : ""}
                    </span>
                  ))}
                  {good.boards.length === 0 ? <span className="text-xs text-muted">没有点名板块</span> : null}
                </div>
              </div>
              <ul className="flex flex-col gap-2">
                {good.stocks.map((stock) => {
                  const mark = heldSet.has(stock.id) ? "持仓" : pickedSet.has(stock.id) ? "精选" : "";
                  return (
                    <li key={stock.id} className="rounded-xl bg-surface-2 px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0 truncate font-medium">
                          {stock.name}
                          <span className="ml-2 text-xs font-normal text-muted">{stock.code}</span>
                          {mark ? (
                            <span className={"ml-2 rounded-full px-2 py-0.5 text-xs font-normal " + (mark === "持仓" ? "bg-up-soft text-up" : "bg-[#123044] text-[#5ad7ff]")}>
                              {mark}
                            </span>
                          ) : null}
                        </div>
                        <div className={toneClass(stock.chg) + " shrink-0 text-sm tabular-nums"}>{signedPct(stock.chg)}</div>
                      </div>
                      <p className="mt-1 text-xs text-pretty text-muted">{stock.title}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
        {bad.boards.length > 0 || bad.stocks.length > 0 ? (
          <section className="rounded-2xl border border-line bg-surface px-4 py-3">
            <h2 className="font-serif text-lg font-semibold">利空</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {bad.boards.map((board) => (
                <span key={board.code} className="rounded-full bg-down-soft px-2 py-0.5 text-xs text-down">
                  {board.name}
                  {board.n > 1 ? ` ${board.n}` : ""}
                </span>
              ))}
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {bad.stocks.map((stock) => (
                <li key={stock.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    {stock.name} <span className="text-xs text-muted">{stock.code}</span>
                  </span>
                  <span className={toneClass(stock.chg) + " shrink-0 tabular-nums"}>{signedPct(stock.chg)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className="rounded-2xl border border-line bg-surface">
          <div className="px-4 py-3">
            <h2 className="font-serif text-lg font-semibold">7x24</h2>
            <p className="mt-1 text-xs text-muted">利好在前。板块和个股是快讯自己点的名。</p>
          </div>
          {ordered.length === 0 ? (
            <p className="border-t border-line px-4 py-6 text-sm text-muted">没有拉到快讯。</p>
          ) : (
            <ul>
              {ordered.map((item) => {
                return (
                  <li key={item.id} className="border-t border-line px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className="tabular-nums">{item.time.slice(5, 16)}</span>
                      <span className={item.tone === "good" ? "text-up" : item.tone === "bad" ? "text-down" : ""}>{TONE_LABEL[item.tone]}</span>
                    </div>
                    <h3 className="mt-1 text-sm font-medium text-pretty">{item.title}</h3>
                    {item.summary && item.summary !== item.title ? (
                      <p className="mt-1 line-clamp-3 text-xs text-pretty leading-5 text-muted">{item.summary}</p>
                    ) : null}
                    {item.boards.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.boards.map((board) => (
                          <span key={board.code} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg">
                            {board.name}
                          </span>
                        ))}
                      </div>
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
      </Frame>
  );
}
