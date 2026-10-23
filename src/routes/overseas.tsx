/**
 * 这个文件是干什么的：
 * 「港美行情」页——港股和美股的行情查看。**只做行情，不接策略**
 * （用户 2026-10-14 明确「港股美股不用策略，只要有行情能看数据就好了」）。
 *
 * 三个页签，对应用户要的三种形态：
 * 1. **行情列表**：港股 17429 只 / 美股 13854 只，按需分页（一次一页 100 只），
 *    可按涨跌幅/现价/成交额排序。**本页只有一页，搜不到的东西要说清**
 *    （要搜全市场得走 suggest，页面上给了搜索框）
 * 2. **指数**：恒生、国企、恒生科技、道指、纳指、标普，带昨收涨跌
 * 3. **我的港美**：自选里的港美票，逐只拉行情（A 股自选不走这里，那边有全市场快照）
 *
 * 你需要知道的（纪律）：
 * 1. **币种必须标**。港币和美元不是同一种钱，价格列不给单位会读错。
 * 2. **指数跨两个域**：恒生/国企/道指/纳指/标普在 100，恒生科技在 124。
 *    按恒生系列的直觉写 100.HSTECH 实测返回 null。
 * 3. **这一页没有买卖建议、没有选股、没有策略评分**，以后也别加。A 股那套
 *    （涨跌停/换手率闸/ST/板块/流通市值）在美股没有对应物，硬套是语义错误。
 * 4. 停牌/未开盘的票涨跌幅可能是 null，页面显示「—」不是 0。
 * 5. **美股列表里混着权证**（COPL_WS / BBAI_WS 这类代码带 _WS 的），页面只列正股，
 *    跳过的数量会在页面上说明——静默丢会让「本页 100 只」看着像完整。
 * 6. **指数不给日内走势**：东财对 100/124 域的指数 K 线返回空数组，指数区只有现价+涨跌。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import {
  getOverseasIndices,
  getOverseasList,
  getOverseasWatchQuotes,
} from "@/lib/market/overseas-list.functions";
import { filterOverseas, sortOverseas, type OverseasMarket, type OverseasSort } from "@/lib/market/overseas-list";
import { fmtPrice, toneClass } from "@/lib/market/format";

type Tab = "list" | "indices" | "watch";

export const Route = createFileRoute("/overseas")({
  // 显式标注返回类型：否则字面量会被推成 string，search.market 就传不进
  // 要 OverseasMarket 的 serverFn 了
  validateSearch: (search: Record<string, unknown>): { tab: Tab; market: OverseasMarket; page: number; sort: OverseasSort } => ({
    tab: search.tab === "indices" || search.tab === "watch" ? search.tab : "list",
    market: search.market === "us" ? "us" : "hk",
    page: typeof search.page === "number" && search.page >= 1 ? Math.min(Math.round(search.page), 200) : 1,
    sort: search.sort === "price" || search.sort === "amount" || search.sort === "code" ? search.sort : "chg",
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab, market: search.market, page: search.page, sort: search.sort }),
  loader: async ({ deps }) => {
    const [list, indices, watch] = await Promise.all([
      deps.tab === "list"
        ? getOverseasList({ data: { market: deps.market, page: deps.page, sort: deps.sort } }).catch(() => null)
        : Promise.resolve(null),
      deps.tab === "indices" ? getOverseasIndices().catch(() => null) : Promise.resolve(null),
      deps.tab === "watch" ? getOverseasWatchQuotes().catch(() => null) : Promise.resolve(null),
    ]);
    return { list, indices, watch };
  },
  component: OverseasPage,
});

const TABS: { id: Tab; label: string }[] = [
  { id: "list", label: "行情列表" },
  { id: "indices", label: "指数" },
  { id: "watch", label: "我的港美" },
];

const SORT_LABEL: Record<OverseasSort, string> = { chg: "涨跌幅", price: "现价", amount: "成交额", code: "代码" };

function OverseasPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [q, setQ] = useState("");
  const { list, indices, watch } = Route.useLoaderData();

  function go(patch: Partial<{ tab: Tab; market: OverseasMarket; page: number; sort: OverseasSort }>) {
    void navigate({
      to: "/overseas",
      search: { tab: patch.tab ?? search.tab, market: patch.market ?? search.market, page: patch.page ?? 1, sort: patch.sort ?? search.sort },
    });
  }

  return (
    <Frame
      aside="港美行情"
      ornamentContent={
        // **真实数据**：indices[0] 是当前 tab 关注的那组指数里的第一个。
        // pct 可能为 null（休市/没拿到）——那就只说名字，不编 0%。
        indices && indices.quotes.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            {indices.quotes[0]!.name}
            {/* 用 chg（涨跌幅）不用 price：指数点位要 ÷100 还原，写错就错 100 倍；
                涨跌幅是现价和昨收算的比例，缩放无关（见 overseas-list.functions.ts 注释）。 */}
            {indices.quotes[0]!.chg != null
              ? ` ${indices.quotes[0]!.chg > 0 ? "+" : ""}${indices.quotes[0]!.chg.toFixed(2)}%`
              : " 涨跌未取到"}
          </span>
        ) : (
          <span className="text-[11px]">指数快照暂不可用</span>
        )
      }
    >
      <Panel title="港美行情" note="只看数据，不做策略">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => go({ tab: tab.id })}
              className={
                "rounded border px-2.5 py-1 text-xs transition " +
                (search.tab === tab.id ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
              }
            >
              {tab.label}
            </button>
          ))}
          <span className="ml-2 text-[11px] text-muted">
            港股和美股都只做行情查看。涨跌停、换手率闸、ST 这些 A 股特有的东西在美股没有，
            所以这里没有选股也没有策略评分。
          </span>
        </div>

        {search.tab === "list" ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
              {(["hk", "us"] as OverseasMarket[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => go({ market: m, page: 1 })}
                  className={
                    "rounded border px-2.5 py-1 text-xs transition " +
                    (search.market === m ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
                  }
                >
                  {m === "hk" ? "港股" : "美股"}
                </button>
              ))}
              {(Object.keys(SORT_LABEL) as OverseasSort[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => go({ sort: s, page: 1 })}
                  className={
                    "rounded border px-2 py-1 text-xs transition " +
                    (search.sort === s ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
                  }
                >
                  按{SORT_LABEL[s]}
                </button>
              ))}
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`在本页里筛（${list?.size ?? 100} 只）`}
                className="w-44 rounded border border-line bg-transparent px-2 py-1 text-xs text-fg placeholder:text-muted"
              />
              <span className="text-[11px] text-muted">
                本页只有 {list?.size ?? 100} 只，筛不出来的就是不在这一页。要找特定的票去「个股查询」搜（联想接口搜全市场）。
              </span>
            </div>

            {!list ? (
              <StateBlock kind="empty" title="没拉到" hint="东财港美域没返回。稍后再试，或者看「指数」那页有没有数据。" />
            ) : list.rows.length === 0 ? (
              <StateBlock kind="empty" title="这一页没有数据" hint={list.why ?? "换个排序或翻页试试。"} />
            ) : (
              <MarketTable rows={sortOverseas(filterOverseas(list.rows, q), search.sort, true)} market={search.market} />
            )}

            {list && list.total > 0 ? (
              <div className="flex items-center gap-2 border-t border-line px-3.5 py-2">
                <button type="button" onClick={() => go({ page: Math.max(1, search.page - 1) })} disabled={search.page <= 1} className="rounded border border-line px-2 py-1 text-xs text-muted disabled:opacity-40">
                  上一页
                </button>
                <span className="text-[11px] text-muted">
                  第 {search.page} 页 / 共 {Math.ceil(list.total / list.size)} 页（{search.market === "hk" ? "港股" : "美股"}共 {list.total} 只，含仙股和权证）
                </span>
                <button type="button" onClick={() => go({ page: search.page + 1 })} disabled={search.page * list.size >= list.total} className="rounded border border-line px-2 py-1 text-xs text-muted disabled:opacity-40">
                  下一页
                </button>
              </div>
            ) : null}
            {list && list.bad > 0 ? (
              <GapList
                items={[
                  `这一页有 ${list.bad} 只没列出来：绝大多数是美股权证（代码带 _WS 之类），不是正股。权证和正股混在一起看没意义，所以只列正股`,
                ]}
              />
            ) : null}
          </>
        ) : null}

        {search.tab === "indices" ? (
          !indices ? (
            <StateBlock kind="empty" title="没拉到" hint="指数走东财港美域，没返回就是它那边的问题。" />
          ) : indices.quotes.length === 0 ? (
            <StateBlock kind="empty" title="没有指数数据" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-3 lg:grid-cols-6">
                {indices.quotes.map((q) => (
                  <Stat
                    key={q.id}
                    label={q.name}
                    value={q.price == null ? "—" : q.price.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                    tone={q.chg == null ? undefined : toneClass(q.chg)}
                    hint={q.chg == null ? "没取到涨跌" : `${q.chg >= 0 ? "+" : ""}${q.chg.toFixed(2)}% 较前一交易日`}
                  />
                ))}
              </div>
              <p className="px-3.5 pb-2 text-[11px] text-muted">
                点位是东财原始值 ÷100 还原的（实测：道指 51670.10、恒生 24282.25 都是真实点位）；涨跌幅用现价和昨收算比例，
                不受这个缩放影响。东财对指数不给日内走势（K 线返回空），所以这里只有现价和涨跌，想看走势图得另找源。
                休市时不更新，显示的是昨收。
              </p>
              {indices.gaps.length > 0 ? <GapList items={indices.gaps} title="没取到的" /> : null}
            </>
          )
        ) : null}

        {search.tab === "watch" ? (
          !watch ? (
            <StateBlock kind="empty" title="没拉到" hint="自选港美票是逐只问东财的，失败就是它那边的问题。" />
          ) : watch.rows.length === 0 ? (
            <StateBlock
              kind="empty"
              title="自选里没有港美票"
              hint="去「自选与持仓」页加港美代码（hk00700 / usNVDA 这种带前缀的）。加完了回来看这里。"
            />
          ) : (
            <table className="data-table w-full">
              <caption className="sr-only">自选里的港美票行情</caption>
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass("text-left")}>名称</th>
                  <th className={thClass("text-left")}>代码</th>
                  <th className={thClass()}>现价</th>
                  <th className={thClass()}>涨跌</th>
                  <th className={thClass("text-left")}>行情日期</th>
                </tr>
              </thead>
              <tbody>
                {watch.rows.map((r) => (
                  <tr key={r.id} className="border-b border-line/60">
                    <td className={tdClass("text-left")}>
                      <span className="text-fg">{r.name}</span>
                    </td>
                    <td className={tdClass("text-left text-muted")}>{r.id}</td>
                    <td className={tdClass("text-right " + toneClass(r.chg))}>
                      {fmtPrice(r.price)}
                      <span className="ml-1 text-[11px] text-muted">{r.currency}</span>
                    </td>
                    <td className={tdClass("text-right " + toneClass(r.chg))}>{r.chg == null ? "—" : `${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}%`}</td>
                    <td className={tdClass("text-left text-muted")}>{r.asOf}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Panel>
    </Frame>
  );
}

function MarketTable({ rows, market }: { rows: ReturnType<typeof sortOverseas>; market: OverseasMarket }) {
  return (
    <table className="data-table w-full">
      <caption className="sr-only">{market === "hk" ? "港股" : "美股"}行情列表：代码、名称、现价、涨跌幅、成交额</caption>
      <thead>
        <tr className="border-b border-line">
          <th className={thClass("text-left")}>代码</th>
          <th className={thClass("text-left")}>名称</th>
          <th className={thClass()}>现价</th>
          <th className={thClass()}>涨跌幅</th>
          <th className={thClass()}>涨跌额</th>
          <th className={thClass()}>成交额</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-line/60">
            <td className={tdClass("text-left text-muted")}>{r.code}</td>
            <td className={tdClass("text-left")}>
              <span className="text-fg">{r.name}</span>
            </td>
            <td className={tdClass("text-right " + toneClass(r.chg))}>
              {r.price == null ? "—" : r.price}
              <span className="ml-1 text-[11px] text-muted">{r.currency}</span>
            </td>
            <td className={tdClass("text-right " + toneClass(r.chg))}>{r.chg == null ? "—" : `${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(2)}%`}</td>
            <td className={tdClass("text-right text-muted")}>{r.chgAmt == null ? "—" : r.chgAmt.toFixed(3)}</td>
            <td className={tdClass("text-right text-muted")}>
              {r.amount == null ? "—" : r.amount >= 1e8 ? `${(r.amount / 1e8).toFixed(2)} 亿` : `${(r.amount / 1e4).toFixed(0)} 万`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
