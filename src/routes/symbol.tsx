import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { getSymbolNews } from "@/lib/market/quotes.functions";
import type { NewsTone } from "@/lib/market/news";

const TONE_LABEL: Record<NewsTone, string> = { good: "利好", bad: "利空", flat: "未表态" };

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
      <p className="text-xs text-muted">按标题用词分成利好或利空，不是研报，也不改买入价。</p>
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
  articles,
  empty,
}: {
  title: string;
  articles: { id: string; time: string; title: string; tone: NewsTone; url: string }[];
  empty: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-base font-semibold">{title}</h2>
      {articles.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul>
          {articles.map((item) => (
            <li key={item.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
                <span className={item.tone === "good" ? "text-up" : item.tone === "bad" ? "text-down" : ""}>{TONE_LABEL[item.tone]}</span>
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
