import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { signedPct, toneClass } from "@/lib/market/format";
import { articleLine, drawSymbolPoster } from "@/lib/market/page-posters";
import { shanghaiDate } from "@/lib/market/session";
import { getSymbolNews } from "@/lib/market/quotes.functions";
import type { NewsTone, StockArticle } from "@/lib/market/news";

const TONE_LABEL: Record<NewsTone, string> = { good: "利好", bad: "利空", flat: "未表态" };
const KIND_LABEL = { news: "资讯", ann: "公告" };

function tally(articles: StockArticle[]) {
  return {
    bad: articles.filter((item) => item.tone === "bad").length,
    good: articles.filter((item) => item.tone === "good").length,
    ann: articles.filter((item) => item.kind === "ann").length,
  };
}

export const Route = createFileRoute("/symbol")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q.trim().slice(0, 20) : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => getSymbolNews({ data: { q: deps.q } }),
  component: SymbolPage,
});

function SymbolPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [value, setValue] = useState(search.q);
  useEffect(() => setValue(search.q), [search.q]);

  return (
    <Frame>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({ to: "/symbol", search: { q: value.trim() } });
        }}
      >
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="代码或名称"
          maxLength={20}
          className="min-w-0 flex-1 rounded-full border border-line bg-surface px-4 py-2 text-sm outline-none"
        />
        <button type="submit" className="rounded-full border border-line bg-surface px-4 py-2 text-sm">
          搜索
        </button>
      </form>
      <p className="text-xs text-muted">资讯和公告按标题用词分成利好或利空。有利空的持仓排在前面。不改买入价。</p>
      <PosterButton
        draw={() => {
          const date = shanghaiDate();
          if (data.picked) {
            const counts = tally(data.articles);
            return drawSymbolPoster({
              date,
              title: `${data.picked.name} ${data.picked.code}`,
              chg: data.picked.chg,
              good: counts.good,
              bad: counts.bad,
              ann: counts.ann,
              lines: data.articles.map(articleLine),
            });
          }
          const good = data.groups.reduce((sum, group) => sum + group.articles.filter((item) => item.tone === "good").length, 0);
          const bad = data.groups.reduce((sum, group) => sum + group.articles.filter((item) => item.tone === "bad").length, 0);
          const ann = data.groups.reduce((sum, group) => sum + group.articles.filter((item) => item.kind === "ann").length, 0);
          return drawSymbolPoster({
            date,
            title: "持仓消息",
            chg: null,
            good,
            bad,
            ann,
            lines: data.groups.slice(0, 8).map((group) => {
              const counts = tally(group.articles);
              const tone = counts.bad > 0 ? "bad" : counts.good > 0 ? "good" : "flat";
              return { label: signedPct(group.chg), text: `${group.name} 利空${counts.bad} 利好${counts.good}`, tone };
            }),
          });
        }}
      />
      {data.q && data.matches.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto scroll-slim">
          {data.matches.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setValue(item.code);
                void navigate({ to: "/symbol", search: { q: item.code } });
              }}
              className={"shrink-0 rounded-full border border-line px-3 py-1 text-xs " + (data.picked?.id === item.id ? "bg-surface text-fg" : "text-muted")}
            >
              {item.name} {item.code}
            </button>
          ))}
        </div>
      ) : null}
      {data.q ? (
        <ArticleList
          title={data.picked ? `${data.picked.name} ${data.picked.code}` : `没有找到「${data.q}」`}
          chg={data.picked?.chg ?? null}
          articles={data.articles}
          empty={data.picked ? "这只股票暂时没有消息。" : "换一个代码或名称。"}
        />
      ) : data.groups.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">账上没有持仓。上面可以搜一只股票。</p>
      ) : (
        data.groups.map((group) => (
          <ArticleList
            key={group.id}
            title={`${group.name} ${group.code}`}
            chg={group.chg}
            articles={group.articles}
            empty="暂时没有消息。"
          />
        ))
      )}
    </Frame>
  );
}

function ArticleList({
  title,
  chg,
  articles,
  empty,
}: {
  title: string;
  chg: number | null;
  articles: StockArticle[];
  empty: string;
}) {
  const counts = tally(articles);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {articles.length > 0 ? (
            <p className="mt-0.5 text-xs text-muted">
              <span className={counts.bad > 0 ? "text-down" : ""}>利空 {counts.bad}</span>
              {` · 利好 ${counts.good} · 公告 ${counts.ann}`}
            </p>
          ) : null}
        </div>
        <span className={toneClass(chg) + " shrink-0 tabular-nums"}>{signedPct(chg)}</span>
      </div>
      {articles.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul>
          {articles.map((item) => (
            <li key={item.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
                <span>
                  <span className="mr-2">{KIND_LABEL[item.kind]}</span>
                  <span className={item.tone === "good" ? "text-up" : item.tone === "bad" ? "text-down" : ""}>{TONE_LABEL[item.tone]}</span>
                </span>
                <span className="tabular-nums">{item.time.slice(5, 16)}</span>
              </div>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block text-sm">
                  {item.title}
                </a>
              ) : (
                <p className="mt-1 text-sm">{item.title}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
