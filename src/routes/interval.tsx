/**
 * 区间统计（/interval）——选一段日子，看这段时间里谁真的涨了、哪些题材整体在涨。
 *
 * 为什么值得单独一页：日涨幅、连板、涨停都只回答「今天」。真正决定亏赚的是
 * 「这一段我拿的票在不在涨的那堆里」，而这个视角原来的页面一个都没有。
 *
 * 口径与缺口（都印在页面上）：
 * - 涨幅 = 末日收盘 ÷ 起日收盘 − 1，只用本地日线收盘价，不联网。
 * - **没有「区间资金净额」**：本地资金流只覆盖 343 只 × 120 天，不足全市场。
 *   缺就是缺，不用 0 顶替，也不拿别的东西冒充。
 * - 板块用成分股涨幅的**中位数**，不用均值——一只 +300% 的票能把均值拉飞，
 *   中位数才回答「这个题材里随便挑一只能不能赚」。
 * - 首尾两天都有价的票才参与（停牌、新股自然被排除），页面显示覆盖数。
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getInterval } from "@/lib/market/archive.functions";

export const Route = createFileRoute("/interval")({
  validateSearch: (raw: Record<string, unknown>): { from?: string; to?: string } => ({
    from: typeof raw.from === "string" ? raw.from : undefined,
    to: typeof raw.to === "string" ? raw.to : undefined,
  }),
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  loader: async ({ deps }) => await getInterval({ data: { from: deps.from ?? "", to: deps.to ?? "" } }),
  component: IntervalPage,
});

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

function IntervalPage() {
  const p = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();

  if (!p) {
    return (
      <Frame wide>
        <Panel title="区间统计">
          <StateBlock kind="empty" title="还没建收盘价索引" hint="跑 scripts/closes-index.ts（读本地 K 线，不联网）。" />
        </Panel>
      </Frame>
    );
  }

  const go = (from: string, to: string) => void navigate({ to: "/interval", search: { from, to } });
  const up = p.stocks.filter((s) => s.chg > 0).length;
  const top = p.stocks.slice(0, 200);
  const bottom = p.stocks.slice(200);
  const upBoards = p.boards.filter((b) => b.median > 0).length;

  return (
    <Frame
      wide
      aside={
        <span className="num text-xs text-muted">
          {p.from} → {p.to} · {p.sessions} 个交易日 · 覆盖 {p.covered}/{p.universe} 只
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel
          title="选区间"
          note={
            <span className="flex items-center gap-1.5 text-[12px]">
              <button type="button" className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-brand hover:text-brand-text" onClick={() => go(p.dates[Math.max(0, p.dates.length - 6)], p.dates[p.dates.length - 1])}>近 5 日</button>
              <button type="button" className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-brand hover:text-brand-text" onClick={() => go(p.dates[Math.max(0, p.dates.length - 21)], p.dates[p.dates.length - 1])}>近 20 日</button>
              <button type="button" className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-brand hover:text-brand-text" onClick={() => go(p.dates[Math.max(0, p.dates.length - 61)], p.dates[p.dates.length - 1])}>近 60 日</button>
              <button type="button" className="rounded border border-line px-1.5 py-0.5 text-muted hover:border-brand hover:text-brand-text" onClick={() => go(p.dates[0], p.dates[p.dates.length - 1])}>全部</button>
            </span>
          }
        >
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span className="text-muted">从</span>
            <select
              className="rounded border border-line bg-surface px-2 py-1"
              value={p.from}
              onChange={(e) => go(e.target.value, p.to)}
            >
              {p.dates.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span className="text-muted">到</span>
            <select
              className="rounded border border-line bg-surface px-2 py-1"
              value={p.to}
              onChange={(e) => go(p.from, e.target.value)}
            >
              {p.dates.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span className="text-[12px] text-muted">
              {search.from || search.to ? "" : "默认给最近 20 个交易日"}
            </span>
          </div>
        </Panel>

        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="个股区间涨幅" note={<span className="text-[12px]">前 200 名 · 共 {p.covered} 只有价</span>}>
            <div className="border-b border-line px-3 py-1.5 text-[12px] text-muted">
              这段里有 <b className="num text-up">{up}</b> 只上涨、
              <b className="num text-down">{p.covered - up}</b> 只下跌。
            </div>
            <div className="overflow-x-auto px-3 py-2 scroll-slim">
              <table className="data-table w-full min-w-[420px] text-xs">
                <thead>
                  <tr>
                    <th className="w-8 text-right">#</th>
                    <th className="text-left">名称</th>
                    <th className="text-right">起</th>
                    <th className="text-right">终</th>
                    <th className="text-right">涨幅</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((s, i) => (
                    <tr key={s.id}>
                      <td className="num text-right text-muted">{i + 1}</td>
                      <td>
                        <Link to="/symbol" search={{ q: s.id }} className="hover:underline">{s.name}</Link>
                      </td>
                      <td className="num text-right text-muted">{s.from.toFixed(2)}</td>
                      <td className="num text-right text-muted">{s.to.toFixed(2)}</td>
                      <td className={"num text-right font-medium " + (s.chg >= 0 ? "text-up" : "text-down")}>{pct(s.chg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="flex flex-col gap-3">
            <Panel title="题材区间涨幅" note={<span className="text-[12px]">成分股涨幅中位数 · {p.boards.length} 个题材</span>}>
              <div className="border-b border-line px-3 py-1.5 text-[12px] text-muted">
                {p.boards.length === 0
                  ? "题材分类没读到，这一栏空着。"
                  : <>这段里有 <b className="num text-up">{upBoards}</b> 个题材中位数为正、<b className="num text-down">{p.boards.length - upBoards}</b> 个为负。</>}
              </div>
              <div className="max-h-[520px] overflow-y-auto px-3 py-2 scroll-slim">
                <table className="data-table w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">题材</th>
                      <th className="text-right">成分</th>
                      <th className="text-right">中位</th>
                      <th className="text-left">最强</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.boards.slice(0, 40).concat(p.boards.slice(-10)).map((b) => (
                      <tr key={b.name}>
                        <td className="max-w-[150px] truncate">{b.name}</td>
                        <td className="num text-right text-muted">{b.covered}/{b.members}</td>
                        <td className={"num text-right " + (b.median >= 0 ? "text-up" : "text-down")}>{pct(b.median)}</td>
                        <td className="max-w-[90px] truncate text-[12px] text-muted">{b.top}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="跌得最多的 50 只" note={<span className="text-[12px]">区间跌幅榜尾</span>}>
              <div className="overflow-x-auto px-3 py-2 scroll-slim">
                <table className="data-table w-full min-w-[380px] text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">名称</th>
                      <th className="text-right">起</th>
                      <th className="text-right">终</th>
                      <th className="text-right">涨幅</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bottom.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <Link to="/symbol" search={{ q: s.id }} className="hover:underline">{s.name}</Link>
                        </td>
                        <td className="num text-right text-muted">{s.from.toFixed(2)}</td>
                        <td className="num text-right text-muted">{s.to.toFixed(2)}</td>
                        <td className={"num text-right " + (s.chg >= 0 ? "text-up" : "text-down")}>{pct(s.chg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="这一页缺什么（先说清楚）">
          <div className="flex flex-col gap-1.5 px-3 py-3 text-[12px] leading-relaxed text-muted">
            <div>
              <Tag tone="warn">缺口</Tag>{" "}
              <b className="text-fg">没有区间资金净额。</b>本地资金流只覆盖 343 只 × 120 天，不够全市场，
              所以这一页只给涨幅。弈盘那页有「区间净额」，是因为它接了全市场资金接口，赤轨没有。
            </div>
            <div>
              <Tag tone="muted">口径</Tag>{" "}
              首尾两天都有收盘价的票才算进来（{p.covered}/{p.universe}）。区间内停牌过的票、
              区间内上市的新股自然被排除，所以「涨的只数」不等于全市场。
            </div>
            <div>
              <Tag tone="muted">口径</Tag>{" "}
              题材用中位数不用均值：一只 +300% 的票足以让均值翻倍，中位数才回答
              「这个题材里随便挑一只能不能赚」。
            </div>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
