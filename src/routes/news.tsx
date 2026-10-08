/**
 * 这个文件是干什么的：
 * 「消息」页。上面把快讯分成利好和利空两栏，并标出持仓或精选里出现的股票。
 * 下面是按时间排的 7×24 快讯，点「生成汇总图」可以存一张图。
 *
 * 你需要知道的：
 * 利好利空只看快讯用词，不是研报。看消息、生成图片都不会改买入价。
 */

import { createFileRoute } from "@tanstack/react-router";
import { StockName } from "@/components/screener/stock-name";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { Panel } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { signedPct, toneClass } from "@/lib/market/format";
import { drawNewsPoster } from "@/lib/market/page-posters";
import { shanghaiDate } from "@/lib/market/session";
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

/** 消息页路由。先拉快讯和持仓，再给精选里的股票做标记；已持仓的不再标成精选。 */
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

function ToneSide({
  title,
  tone,
  boards,
  stocks,
  held,
  picked,
  failed,
}: {
  title: string;
  tone: "good" | "bad";
  boards: { code: string; name: string; n: number }[];
  stocks: { id: string; name: string; code: string; chg: number | null; title: string }[];
  held: Set<string>;
  picked: Set<string>;
  /** 快讯整体没拉到。这时候是「降级」不是「没有」，两件事要分开说。 */
  failed: boolean;
}) {
  const quiet = tone === "good" ? "text-up" : "text-down";
  return (
    // 侧边一条红/绿：同花顺那种「一栏一个色调」的排法。标题之外再给一个视觉锚点，
    // 余光扫过去就知道这栏是利好还是利空。
    // bg-surface 是配合外层 gap-px + bg-line 的分隔线：两栏之间那条 1px 由外层垫出来。
    <div
      className="min-w-0 border-l-2 bg-surface px-4 py-3.5"
      // 直接引 CSS 变量，不赌 Tailwind 能不能从 @theme 生成 border-l-up 这类类名
      style={{ borderLeftColor: tone === "good" ? "var(--color-up)" : "var(--color-down)" }}
    >
      {/* h3：外层 Panel 的标题「利好 / 利空」已经是 h2，这两栏是它的下一级 */}
      <h3 className={"text-sm font-medium " + quiet}>{title}</h3>
      {boards.length === 0 && stocks.length === 0 ? (
        <div className="mt-2">
          <StateBlock
            compact
            kind={failed ? "error" : "empty"}
            title={
              failed
                ? "消息暂时拉不下来"
                : tone === "good"
                  ? "这批没有判成利好的"
                  : "这批没有判成利空的"
            }
            hint={
              failed
                ? "快讯源没响应，不是这一栏没内容——等源恢复了会自己填上。"
                : "利好利空只看快讯用词，不是研报。换一批快讯结果就会变。"
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {boards.map((board) => (
              <span key={board.code} className="rounded bg-surface-2 px-2.5 py-1 text-xs">
                {board.name}
                {board.n > 1 ? <span className="text-muted"> {board.n}</span> : null}
              </span>
            ))}
          </div>
          <ul className="mt-2">
            {stocks.map((stock) => {
              const mark = held.has(stock.id) ? "持仓" : picked.has(stock.id) ? "精选" : "";
              return (
                <li key={stock.id} className="border-t border-line py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate">
                      <StockName id={stock.id} name={stock.name} source="news" />
                      <span className="ml-1.5 text-muted">{stock.code}</span>
                      {mark ? <span className={"ml-1.5 " + quiet}>{mark}</span> : null}
                    </div>
                    <div className={toneClass(stock.chg) + " shrink-0 tabular-nums"}>{signedPct(stock.chg)}</div>
                  </div>
                  <p className="truncate text-muted">{stock.title}</p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

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
        <PosterButton
          draw={() =>
            drawNewsPoster({
              date: shanghaiDate(),
              goodBoards: good.boards,
              badBoards: bad.boards,
              goodStocks: good.stocks,
              badStocks: bad.stocks,
              total: news.length,
            })
          }
        />
        <Panel
          title="利好 / 利空"
          note={<span>按快讯用词归类，不是研报，也不改买入价。</span>}
        >
          {/* 两栏之间用红/绿侧边条分隔：同花顺那种「一栏一个色调」的排法，
              余光扫过去就知道这栏是利好还是利空，不用读标题。 */}
          {/* 分隔线用 gap-px + bg-line 垫出来，不是 divide-x：
              窄屏上下堆叠时那条 1px 也在，两栏的边界在哪一眼就清楚了。 */}
          <div className="grid gap-px bg-line md:grid-cols-2">
            <ToneSide
              title="利好"
              tone="good"
              boards={good.boards}
              stocks={good.stocks}
              held={heldSet}
              picked={pickedSet}
              failed={failed}
            />
            <ToneSide
              title="利空"
              tone="bad"
              boards={bad.boards}
              stocks={bad.stocks}
              held={heldSet}
              picked={pickedSet}
              failed={failed}
            />
          </div>
        </Panel>
        <Panel title="7x24 电报" note={<span>利好在前。板块和个股是快讯自己点的名。</span>}>
          {ordered.length === 0 ? (
            <StateBlock
              kind={failed ? "error" : "empty"}
              title={failed ? "快讯暂时拉不下来" : "这批没有快讯"}
              hint={
                failed
                  ? "消息源没响应。行情和持仓不受影响，只有这一页空着。"
                  : "快讯按时间倒序排，利好在前。休市时本来就没有新快讯。"
              }
            />
          ) : (
            <ul>
              {ordered.map((item) => {
                return (
                  <li key={item.id} className="border-t border-line px-4 py-2.5 first:border-t-0">
                    {/* 时间占固定 44px：每条快讯的正文左边缘对齐，扫的时候不用左右找 */}
                    <div className="flex gap-3.5">
                      <div className="w-11 shrink-0">
                        <div className={"text-sm font-medium tabular-nums " + (item.tone === "flat" ? "text-muted" : "text-fg")}>{item.time.slice(11, 16)}</div>
                        <div className="text-xs tabular-nums text-muted">{item.time.slice(5, 10)}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <span
                            className={
                              "shrink-0 rounded-sm px-2 py-0.5 text-xs " +
                              (item.tone === "good" ? "bg-up-soft text-up" : item.tone === "bad" ? "bg-down-soft text-down" : "bg-surface-2 text-muted")
                            }
                          >
                            {TONE_LABEL[item.tone]}
                          </span>
                          <h3 className="text-sm font-medium text-pretty">{item.title}</h3>
                        </div>
                        {item.summary && item.summary !== item.title ? (
                          <p className="mt-1 line-clamp-3 text-xs text-pretty leading-5 text-muted">{item.summary}</p>
                        ) : null}
                        {item.boards.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {item.boards.map((board) => (
                              <span key={board.code} className="rounded-sm bg-surface-2 px-2 py-0.5 text-xs text-fg">
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
                                <span key={stock.id} className={"rounded-sm px-2 py-0.5 text-xs " + (mark === "持仓" ? "bg-up-soft text-up" : mark === "精选" ? "bg-brand-soft text-brand" : "bg-surface-2 text-muted")}>
                                  {stock.name} {signedPct(stock.chg)}
                                  {mark ? ` ${mark}` : ""}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </Frame>
  );
}
