/**
 * 这个文件是干什么的：
 * 「个股」页。不搜索时，列出账上每只持仓的资讯和公告；搜代码或名称就只看那一只。
 * 有多只重名时，上面会出现一排候选，点一下切换。
 *
 * 你需要知道的：
 * 利好利空按标题用词分。有利空的持仓排在前面。看这些消息不会改买入价。
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { PosterButton } from "@/components/screener/poster-button";
import { KlineChart } from "@/components/kline-chart";
import { signedPct, toneClass } from "@/lib/market/format";
import { articleLine, drawSymbolPoster } from "@/lib/market/page-posters";
import { shanghaiDate } from "@/lib/market/session";
import { getKline, getSymbolNews } from "@/lib/market/quotes.functions";
import { qParam } from "@/lib/search-params";
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

/** 个股页路由。地址栏里的 q 是搜索词，进来就按它拉资讯和公告。 */
export const Route = createFileRoute("/symbol")({
  validateSearch: (search: Record<string, unknown>) => ({ q: qParam(search) }),
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
    <Frame
      ornamentContent={
        // **真实数据**：data.picked 是当前查的这只票，data.articles 是它的快讯。
        // 没查票的时候页头就一句提示——不摆上一只票的名字（那是编）。
        data.picked ? (
          <span className="text-[11px] tabular-nums">
            {data.picked.name} · 相关快讯 {data.articles.length} 条
          </span>
        ) : (
          <span className="text-[11px]">输入代码或名称查一只票</span>
        )
      }
    >
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
          className="min-w-0 flex-1 rounded border border-line bg-surface px-3 py-2 text-sm outline-none"
        />
        <button type="submit" className="rounded border border-line bg-surface px-3 py-2 text-sm">
          搜索
        </button>
      </form>
      <p className="text-xs text-muted">
        资讯和公告按标题用词分成利好或利空。有利空的持仓排在前面。不改买入价。
        {data.picked ? (
          <>
            {" "}
            <Link to="/research" search={{ q: data.picked.code }} className="text-accent hover:underline">
              去七阶段研判 →
            </Link>
            {" · "}
            <Link to="/research/debate" search={{ q: data.picked.code }} className="text-accent hover:underline">
              去多空辩论 →
            </Link>
          </>
        ) : null}
      </p>
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
              className={"shrink-0 rounded border px-2.5 py-1.5 text-xs " + (data.picked?.id === item.id ? "border-brand bg-brand-soft font-medium text-brand-text" : "border-line text-muted")}
            >
              {item.name} {item.code}
            </button>
          ))}
        </div>
      ) : null}
      {data.q ? (
        <>
          <SymbolKline id={data.picked?.id ?? null} name={data.picked?.name ?? null} />
          <ArticleList
            title={data.picked ? `${data.picked.name} ${data.picked.code}` : `没有找到「${data.q}」`}
            chg={data.picked?.chg ?? null}
            articles={data.articles}
            empty={data.picked ? "这只股票暂时没有消息。" : "换一个代码或名称。"}
          />
        </>
      ) : data.groups.length === 0 ? (
        <p className="rounded border border-line bg-surface px-3 py-6 text-sm text-muted">账上没有持仓。上面可以搜一只股票。</p>
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

/**
 * 搜中一只票时，资讯列表上方给一张完整蜡烛图（学 Vibe-Research 的个股页 KlineCard）。
 * 独立于 loader：K 线慢，走客户端 query 不拖资讯首屏；没搜中（picked 为空）不渲染。
 */
function SymbolKline({ id, name }: { id: string | null; name: string | null }) {
  const kline = useQuery({
    queryKey: ["kline", id],
    queryFn: () => getKline({ data: { id: id! } }),
    staleTime: 5 * 60_000,
    enabled: id != null,
    retry: false,
  });
  if (!id) return null;
  const bars = kline.data?.bars ?? [];
  return (
    <section className="overflow-hidden rounded border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{name ?? "走势"} · 日 K</h2>
        {kline.isLoading ? (
          <span className="text-xs text-muted">正在取日线</span>
        ) : bars.length < 2 ? (
          <span className="text-xs text-muted">走势暂时没有返回</span>
        ) : (
          <span className="text-xs text-muted">不复权 · 蜡烛红涨绿跌</span>
        )}
      </div>
      {bars.length >= 2 ? (
        <div className="px-1.5 pt-2">
          <KlineChart bars={bars} height={340} />
        </div>
      ) : (
        <p className="px-3.5 py-6 text-sm text-muted">
          {kline.isLoading ? "正在取日线…" : "这根票暂时没有 K 线数据。"}
        </p>
      )}
    </section>
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
    <section className="overflow-hidden rounded border border-line bg-surface">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-3.5 py-2">
        <div className="min-w-0">
          {/* 和 Panel 同档：14px/500。标题的分量交给分隔线，不靠字号 */}
          <h2 className="truncate text-sm font-medium">{title}</h2>
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
        <p className="px-3 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul>
          {articles.map((item) => (
            <li key={item.id} className="border-b border-line px-3.5 py-2 last:border-0">
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
