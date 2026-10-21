/**
 * 这个文件是干什么的：
 * 「自选与持仓」页。自选是我感兴趣的票（不一定在账上），持仓是账本里真买了的——
 * 两件事以前只有后者，想看别的研究标的没地方放。
 *
 * 你需要知道的：
 * - 自选名单存本机 `data/watchlist.json`，**data 不在 git**，换机器不跟过来。
 * - 行情拉失败时价格列显示「—」并说明，不让整页打不开。
 * - 每行带「去研判 / 去辩论」的入口——自选的目的是研究，不是收藏。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Frame } from "@/components/screener/nav";
import { Panel, Table, Tag, pctClass, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getWatchlistFn, addWatchFn, removeWatchFn } from "@/lib/market/watchlist.functions";
import { getUniverse } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/my-stocks")({
  loader: () => getWatchlistFn(),
  component: MyStocksPage,
});

function MyStocksPage() {
  const rows = Route.useLoaderData();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const { data, isFetching } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => getWatchlistFn(),
    staleTime: 30_000,
  });
  // 首次渲染（SSR 和水合）直接用 loader 数据，两边保证一致；
  // useQuery 拿到新数据后再切换过去。不能用 initialData——SSR 阶段它不生效，
  // 服务端画「空名单」、客户端画真数据，水合直接炸 React #418（2026-10-17 实测）。
  const items = (data ?? rows)?.items ?? [];

  async function add() {
    const term = q.trim();
    if (!term) return;
    setHint(null);
    try {
      // 在全市场快照里找这只票：不让用户手打 id，打错一个字符就加到不存在的票
      const uni = await getUniverse({ data: { refresh: false } });
      const hit = uni?.quotes.find((row) => row.code === term || row.name === term || row.id === term) ?? null;
      if (!hit) {
        setHint(`没找到「${term}」。填六位代码或完整名称，例如 600519 或 贵州茅台`);
        return;
      }
      await addWatchFn({ data: { id: hit.id, code: hit.code, name: hit.name } });
      await qc.invalidateQueries({ queryKey: ["watchlist"] });
      setQ("");
    } catch (error) {
      setHint(error instanceof Error ? error.message : "添加失败");
    }
  }

  async function remove(id: string) {
    setHint(null);
    try {
      await removeWatchFn({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["watchlist"] });
    } catch (error) {
      setHint(error instanceof Error ? error.message : "移除失败");
    }
  }

  return (
    <Frame>
      <Panel
        title="自选与持仓"
        note={
          <span className="text-xs text-muted">
            自选存在本机 · 上限 {rows.limit} 只
          </span>
        }
      >
        <div className="flex gap-2 p-3">
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
            placeholder="加一只：六位代码或名称，例如 600519"
            aria-label="添加自选"
            className="min-w-0 flex-1 rounded border border-line bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={isFetching}
            className="shrink-0 rounded bg-brand px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
          >
            加自选
          </button>
        </div>
        {hint ? <p className="px-3 pb-2 text-xs text-warn">{hint}</p> : null}
      </Panel>

      <Panel title="我的自选" note={<span className="text-xs text-muted">{items.length} / {rows.limit}</span>}>
        {items.length === 0 ? (
          <StateBlock
            kind="empty"
            title="还没有自选股"
            hint="在上面填代码或名称加一只。自选是「我感兴趣、想盯着」的票，和「策略追踪」里账上真买了的不是一回事。加完可以直接去研判或辩论。"
          />
        ) : (
          <Table caption="自选股与最新行情">
            <thead>
              <tr>
                <th className={thClass("text-left")}>股票</th>
                <th className={thClass("text-right")}>现价</th>
                <th className={thClass("text-right")}>涨跌</th>
                <th className={thClass("text-right")}>PE</th>
                <th className={thClass("text-left")}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className={tdClass("text-left")}>
                    <Link to="/symbol" search={{ q: row.code }} className="text-accent hover:underline">
                      {row.name}
                    </Link>
                    <span className="ml-2 text-xs text-muted">{row.code}</span>
                  </td>
                  <td className={tdClass()}>{row.quote ? row.quote.price.toFixed(2) : "—"}</td>
                  <td className={tdClass(row.quote?.chg == null ? "text-muted" : pctClass(row.quote.chg))}>
                    {row.quote?.chg == null ? "—" : `${row.quote.chg > 0 ? "+" : ""}${row.quote.chg.toFixed(2)}%`}
                  </td>
                  <td className={tdClass("text-muted")}>{row.quote?.pe == null ? "—" : row.quote.pe.toFixed(1)}</td>
                  <td className={tdClass("text-left")}>
                    <span className="flex gap-2">
                      <Link to="/research" search={{ q: row.code }} className="text-xs text-accent hover:underline">
                        研判
                      </Link>
                      <Link to="/debate" search={{ q: row.code }} className="text-xs text-accent hover:underline">
                        辩论
                      </Link>
                      <button type="button" onClick={() => void remove(row.id)} className="text-xs text-muted hover:text-fg">
                        移除
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data && !data.universeOk && items.length > 0 ? (
          <p className="border-t border-line px-3 py-2 text-xs text-warn">行情没拉到，价格列是「—」；自选名单本身在，等行情恢复再刷新。</p>
        ) : null}
      </Panel>

      <Panel title="账上持仓" note={<Link to="/strategies/positions" className="text-xs text-accent hover:underline">去策略追踪 →</Link>}>
        <div className="px-3 py-2 text-xs leading-relaxed text-muted">
          持仓是记账进程按策略信号真实成交的那些，带买入价、止损空间和盈亏。它和自选是两本账：
          <Tag tone="brand">自选</Tag> 是我感兴趣的，
          <Tag tone="muted">持仓</Tag> 是真金白银在里面的。
        </div>
      </Panel>
    </Frame>
  );
}
