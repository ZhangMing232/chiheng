/**
 * 这个文件是干什么的：
 * 个股抽屉。点任意股票名从右侧滑出，显示行情、所属策略、相关消息、资金流。
 *
 * 你需要知道的：
 * 1. **它由 store 驱动，不由父组件传参**。原来的 `Detail` 收 `quote`/`score`/`reasons`
 *    四个 prop，只能活在选股页里（那里才有 quote 和模型得分）。PPT 要求「点任意股票名
 *    滑出抽屉、不离开当前页」，所以数据改成自己取：行情/持仓/消息/资金流走
 *    `getSymbolPanel`，走势走 `getKline`。港/美股（M1/M2）只有行情：报价走
 *    `getOverseasQuote`，A 股专属区块（账本/筹码/资金/消息）整段不渲染。
 * 2. **模型得分和入选理由是选股页额外给的**（store 的 `note`）。别的页面不知道这两个
 *    数——它们只看得到行情和账本——所以拿不到就显示「未参加当前模型」，不能编一个。
 * 3. **这里只展示，不买入、不改账。** 行情有延迟。港美股的币种是当地货币（港元/美元）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState, Link } from "@tanstack/react-router";
import { Drawer } from "vaul";
import { X } from "lucide-react";
import {
  fmtCap,
  fmtMultiple,
  fmtPlain,
  fmtPrice,
  fmtWan,
  signedPct,
  toneClass,
} from "@/lib/market/format";
import { BOARD_LABEL, boardOf, limitTag } from "@/lib/market/model";
import { currencyLabelOf, marketOf } from "@/lib/market/markets";
import type { Board } from "@/lib/market/types";
import { getKline, getHolders, getLifts, getOverseasQuote } from "@/lib/market/quotes.functions";
import { getSymbolPanel } from "@/lib/market/symbol-panel.functions";
import { useSymbolUi } from "@/lib/ui/symbol-store";
import { StateBlock } from "@/components/state-block";
import { KlineChart } from "@/components/kline-chart";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** 抽屉里的一小块。标题 + 内容，和终端页那几个 Panel 同一个版式。 */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 抽屉标题栏。股票名和板块/涨跌停标记都在行情里，所以这个头必须住在
 * SymbolPanel 里面（要等 query 回来），不能放在抽屉壳上——壳上只有 id。
 */
function PanelHeader({ id, name, tag }: { id: string; name: string | null; tag: string | null }) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-3">
      <div className="min-w-0">
        <div className="text-xs text-muted">
          {name ? BOARD_LABEL[boardOf(id)] : ""}
          {name ? ` · ${id.toUpperCase()}` : id.toUpperCase()}
          {tag ? ` · ${tag}` : ""}
        </div>
        <h2 className="truncate text-sm font-medium">{name ?? "个股详情"}</h2>
      </div>
      <Drawer.Close
        className="inline-flex size-11 items-center justify-center rounded-full bg-surface-2"
        aria-label="关闭"
      >
        <X className="size-4" />
      </Drawer.Close>
    </header>
  );
}

/** 东财个股页 URL。A 股直接 /sh600519.html，港美要走 /hk/、/us/ 子路径（实测）。 */
function eastmoneyUrl(id: string): string {
  if (id.startsWith("hk")) return `https://quote.eastmoney.com/hk/${id.slice(2)}.html`;
  if (id.startsWith("us")) return `https://quote.eastmoney.com/us/${id.slice(2)}.html`;
  return `https://quote.eastmoney.com/${id}.html`;
}

function SymbolPanel({ id }: { id: string }) {
  const note = useSymbolUi((s) => s.note);
  // 港/美（M1/M2）只有行情：账本/消息/资金/两融都是 A 股数据，那些查询直接不发起。
  const isA = marketOf(id) === "a";
  const panel = useQuery({
    queryKey: ["symbol-panel", id],
    queryFn: () => getSymbolPanel({ data: { id } }),
    staleTime: 60_000,
    enabled: isA,
  });
  const overseas = useQuery({
    queryKey: ["overseas-quote", id],
    queryFn: () => getOverseasQuote({ data: { id } }),
    staleTime: 60_000,
    enabled: !isA,
    retry: false,
  });
  // 走势单独一条 query：它慢（要拉 250 根 K 线），独立 loading 才不会拖慢抽屉首屏
  const kline = useQuery({
    queryKey: ["kline", id],
    queryFn: () => getKline({ data: { id } }),
    staleTime: 5 * 60_000,
  });
  // 筹码与解禁也是独立 query：东财 datacenter 慢，失败了只这一块降级，不拖首屏。
  // 服务端有 1 小时缓存，这里 staleTime 同口径，避免每次开抽屉都重打。
  const holders = useQuery({
    queryKey: ["holders", id],
    queryFn: () => getHolders({ data: { id } }),
    staleTime: 60 * 60_000,
    retry: false,
    enabled: isA,
  });
  const lifts = useQuery({
    queryKey: ["lifts", id],
    queryFn: () => getLifts({ data: { id } }),
    staleTime: 60 * 60_000,
    retry: false,
    enabled: isA,
  });

  const loading = isA ? panel.isLoading : overseas.isLoading;
  const failed = isA ? panel.isError : overseas.isError || overseas.data?.why != null;

  if (loading) {
    return (
      <>
        <PanelHeader id={id} name={null} tag={null} />
        <div className="p-6 text-sm text-muted">正在取这只票的行情和持仓</div>
      </>
    );
  }
  if (failed) {
    return (
      <>
        <PanelHeader id={id} name={null} tag={null} />
        <div className="p-4">
          <StateBlock
            kind="error"
            title="取不到这只票的数据"
            hint="可能是没登录，或者服务正在重启。等一会儿再点开一次。"
          />
        </div>
      </>
    );
  }

  const data = isA ? panel.data : undefined;
  const quote = data?.quote ?? null;
  const oQuote = !isA ? (overseas.data?.quote ?? null) : null;
  const bars = kline.data?.bars ?? [];
  const score = isA ? (note?.score ?? null) : null;
  const reasons = isA ? (note?.reasons ?? []) : [];
  const book = data?.book ?? null;
  const currency = currencyLabelOf(id);

  const stats: { label: string; value: string; tone?: number | null }[] = quote
    ? [
        { label: "市盈率", value: fmtMultiple(quote.pe) },
        { label: "市净率", value: fmtMultiple(quote.pb) },
        { label: "总市值", value: fmtCap(quote.cap) },
        { label: "流通市值", value: fmtCap(quote.floatCap) },
        { label: "换手", value: `${fmtPlain(quote.turnover, 2)}%` },
        { label: "量比", value: fmtPlain(quote.volRatio, 2) },
        { label: "振幅", value: `${fmtPlain(quote.amp, 2)}%` },
        { label: "成交额", value: fmtWan(quote.amount) },
        { label: "5 日", value: signedPct(quote.d5), tone: quote.d5 },
        { label: "10 日", value: signedPct(quote.d10), tone: quote.d10 },
        { label: "20 日", value: signedPct(quote.d20), tone: quote.d20 },
        { label: "60 日", value: signedPct(quote.d60), tone: quote.d60 },
        { label: "年初至今", value: signedPct(quote.ytd), tone: quote.ytd },
      ]
    : [];

  return (
    // 不用 fragment：这个面板要占满抽屉并自己滚动，包一层 div 比 <>…</> 少一个闭合出错点
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 名字和板块要等行情回来才有，所以标题栏在 Panel 里而不是抽屉壳上 */}
      <PanelHeader
        id={id}
        name={quote?.name ?? oQuote?.name ?? null}
        tag={quote ? limitTag(quote) : null}
      />
      <div className="flex flex-col gap-4 px-3 py-3">
        {/* 价格 + 模型得分。港美股没有模型得分和 A 股估值数据，只给现价和涨跌幅。 */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <div
              className={cx(
                "text-3xl font-medium tabular-nums",
                quote || oQuote ? toneClass(quote?.chg ?? oQuote?.chg ?? 0) : "text-muted",
              )}
            >
              {quote ? fmtPrice(quote.price) : oQuote ? `${fmtPrice(oQuote.price)} ${currency}` : "—"}
            </div>
            <div className={cx("tabular-nums", quote || oQuote ? toneClass(quote?.chg ?? oQuote?.chg ?? 0) : "text-muted")}>
              {quote ? signedPct(quote.chg) : oQuote ? `${signedPct(oQuote.chg)} · ${oQuote.asOf}` : "取不到现价"}
            </div>
          </div>
          <div className="text-right">
            {score != null ? (
              <>
                <div className="text-xs text-muted">模型得分</div>
                <div className="text-2xl font-medium tabular-nums">{score}</div>
              </>
            ) : (
              <div className="max-w-[9rem] text-xs leading-relaxed text-muted">
                {isA ? "未参加当前模型" : "港美股只看行情"}
                <br />
                {isA ? "只有选股页能给得分" : "选股和账本只覆盖 A 股"}
              </div>
            )}
          </div>
        </div>

        {reasons.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-fg">
            {reasons.map((reason) => (
              <li key={reason} className="rounded bg-surface-2 px-3 py-2">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}

        {/* 所属策略：持仓状态 + 那一笔的数（A 股专属，账本只记 A 股） */}
        {isA ? (
        <Block title="所属策略">
          {book?.trade ? (
            <div className="rounded bg-surface-2 px-3 py-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-fg">{book.styleName}</span>
                <span className="tabular-nums text-muted">{book.trade.state}</span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
                <div className="flex justify-between">
                  <dt className="text-muted">建仓</dt>
                  <dd>{fmtPrice(book.trade.entry)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">{book.trade.exit != null ? "卖出" : "现价"}</dt>
                  <dd
                    className={book.trade.ret != null ? toneClass(book.trade.ret * 100) : undefined}
                  >
                    {book.trade.exit != null
                      ? fmtPrice(book.trade.exit)
                      : fmtPrice(quote?.price ?? book.trade.entry)}
                  </dd>
                </div>
                {book.trade.stop != null ? (
                  <div className="flex justify-between">
                    <dt className="text-muted">止损</dt>
                    <dd>{fmtPrice(book.trade.stop)}</dd>
                  </div>
                ) : null}
                {book.trade.target != null ? (
                  <div className="flex justify-between">
                    <dt className="text-muted">目标</dt>
                    <dd>{fmtPrice(book.trade.target)}</dd>
                  </div>
                ) : null}
                <div className="col-span-2 flex justify-between border-t border-line pt-1">
                  <dt className="text-muted">收益率（含费）</dt>
                  <dd
                    className={
                      book.trade.ret != null ? toneClass(book.trade.ret * 100) : "text-muted"
                    }
                  >
                    {book.trade.ret != null ? signedPct(book.trade.ret * 100) : "取不到现价"}
                  </dd>
                </div>
              </dl>
              <div className="mt-2 text-[11px] text-muted">
                建仓于 {book.trade.day}
                {book.alsoIn.length > 0 ? ` · 别的策略里也记过：${book.alsoIn.join("、")}` : ""}
              </div>
            </div>
          ) : (
            <p className="rounded bg-surface-2 px-3 py-2 text-xs text-muted">
              {data?.why ?? "账本里没有这只票的成交"}
            </p>
          )}
        </Block>
        ) : null}

        {/* 筹码与解禁：户数变化看筹码发散/集中，解禁表是未来的抛压日历（D4，A 股专属） */}
        {isA ? (
        <Block title="筹码与解禁">
          <div className="rounded bg-surface-2 px-3 py-2 text-xs">
            {holders.isLoading ? (
              <p className="text-muted">正在取股东户数</p>
            ) : holders.isError || (holders.data?.length ?? 0) === 0 ? (
              <p className="text-muted">股东户数取不到（季度披露，部分票没有）</p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">股东户数（{holders.data![0].date}）</span>
                  <span className="tabular-nums">
                    {fmtWan(holders.data![0].num / 10_000)}
                    {holders.data![0].chgPct != null ? (
                      <span
                        className={cx(
                          "ml-1.5 tabular-nums",
                          // 户数上升 = 筹码发散（散户变多），下降 = 集中。和涨跌同色口径：发散偏利空用 down
                          holders.data![0].chgPct > 0 ? "text-down" : holders.data![0].chgPct < 0 ? "text-up" : "text-muted",
                        )}
                      >
                        {signedPct(holders.data![0].chgPct)}
                      </span>
                    ) : null}
                  </span>
                </div>
                {holders.data!.length > 1 ? (
                  <ul className="mt-1.5 flex flex-col gap-0.5 tabular-nums text-muted">
                    {holders.data!.slice(1, 4).map((point) => (
                      <li key={point.date} className="flex justify-between">
                        <span>{point.date}</span>
                        <span>
                          {fmtWan(point.num / 10_000)}
                          {point.chgPct != null ? (
                            <span
                              className={cx(
                                "ml-1.5",
                                point.chgPct > 0 ? "text-down" : point.chgPct < 0 ? "text-up" : undefined,
                              )}
                            >
                              {signedPct(point.chgPct)}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1.5 text-[11px] text-muted">户数上升 = 筹码发散，下降 = 集中</p>
              </>
            )}
            <div className="my-2 border-t border-line" />
            {lifts.isLoading ? (
              <p className="text-muted">正在取解禁表</p>
            ) : lifts.isError ? (
              <p className="text-muted">解禁表取不到</p>
            ) : (lifts.data?.length ?? 0) === 0 ? (
              <p className="text-muted">未来 90 天没有解禁</p>
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {lifts.data!.map((row) => (
                    <li key={`${row.date}-${row.type}`} className="flex items-baseline justify-between gap-2">
                      <span className="tabular-nums text-muted">{row.date}</span>
                      <span className="min-w-0 flex-1 truncate">{row.type}</span>
                      <span className="tabular-nums">
                        {fmtPlain(row.sharesYi, 2)} 亿股
                        {row.ratioPct > 0 ? (
                          <span className="ml-1.5 text-down">{fmtPlain(row.ratioPct, 1)}%</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-muted">解禁占总股本比例是未来的抛压，数字越大越要当心</p>
              </>
            )}
            <p className="mt-1.5 text-[11px] text-muted">来源：东财 datacenter，季度披露/已实测</p>
          </div>
        </Block>
        ) : null}

        {/* 走势：蜡烛图 + 成交量 + MA（学 Vibe-Research 的 KlineCard，ECharts 渲染，红涨绿跌） */}
        {kline.isLoading ? (
          <div className="flex h-52 items-center justify-center text-sm text-muted">
            正在取日线
          </div>
        ) : bars.length < 2 ? (
          <div className="flex h-52 items-center justify-center text-sm text-muted">
            走势暂时没有返回
          </div>
        ) : (
          <>
            <KlineChart bars={bars} height={300} />
            <div className="mt-1 flex justify-between text-xs tabular-nums text-muted">
              <span>{bars[0].date.slice(5)}</span>
              <span>不复权日 K · 蜡烛红涨绿跌</span>
              <span>{bars[bars.length - 1].date.slice(5)}</span>
            </div>
          </>
        )}

        {/* 十四项基础数据 */}
        {stats.length > 0 ? (
          <dl className="grid grid-cols-2 gap-2">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded bg-bg px-3 py-2">
                <dt className="text-xs text-muted">{stat.label}</dt>
                <dd
                  className={cx(
                    "tabular-nums",
                    stat.tone != null ? toneClass(stat.tone) : "text-fg",
                  )}
                >
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {/* 资金流（A 股专属；港美股资金流接口未接，不能显示一堆「—」装成没有） */}
        {isA ? (
        <Block title="资金流">
          <div className="rounded bg-surface-2 px-3 py-2 text-xs">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <div className="flex justify-between">
                <dt className="text-muted">这只票主力</dt>
                <dd className={data?.inflow != null ? toneClass(data.inflow) : "text-muted"}>
                  {data?.inflow != null ? fmtWan(data.inflow) : "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">全市场</dt>
                <dd
                  className={
                    data?.marketInflow != null ? toneClass(data.marketInflow) : "text-muted"
                  }
                >
                  {data?.marketInflow != null ? fmtWan(data.marketInflow) : "—"}
                </dd>
              </div>
            </dl>
            <div className="mt-1.5 text-[11px] text-muted">
              {data?.inflowRank ? `今天个股资金榜第 ${data.inflowRank} 名` : "今天没进个股资金榜"}
              {data?.asOf
                ? ` · 数据 ${new Date(data.asOf).toLocaleTimeString("zh-CN", { hour12: false })}`
                : ""}
            </div>
          </div>
        </Block>
        ) : null}

        {/* 相关消息（A 股专属；港美股资讯源未接） */}
        {isA ? (
        <Block title="相关消息">
          {data && data.articles.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs">
              {data.articles.slice(0, 4).map((article) => (
                <li key={article.url ?? article.title} className="rounded bg-surface-2 px-3 py-2">
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block hover:text-brand-text hover:underline"
                  >
                    {article.title}
                  </a>
                  {article.time ? (
                    <div className="mt-0.5 text-[11px] text-muted">{article.time}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded bg-surface-2 px-3 py-2 text-xs text-muted">这只票最近没有消息</p>
          )}
        </Block>
        ) : null}

        {data?.why ? (
          <p className="text-[11px] leading-relaxed text-muted">说明：{data.why}</p>
        ) : null}

        <div className="flex flex-col gap-2">
          {isA ? (
            <Link
              to="/symbol"
              search={{ q: id.replace(/^(sh|sz|bj)/, "") }}
              className="inline-flex h-11 items-center justify-center rounded border border-line text-sm hover:bg-surface-2"
            >
              打开个股页（带完整历史）
            </Link>
          ) : null}
          <a
            className="inline-flex h-11 items-center justify-center rounded border border-line text-sm"
            href={eastmoneyUrl(id)}
            target="_blank"
            rel="noreferrer"
          >
            在东方财富查看这只股票
          </a>
          <p className="text-xs text-pretty text-muted">
            {isA ? "行情有延迟，不是买卖指令。" : "港美股行情有延迟，币种为当地货币；选股和账本只覆盖 A 股。"}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 全局抽屉。挂在路由根，任何页面点股票名都能开。 */
export function SymbolDrawer() {
  const id = useSymbolUi((s) => s.id);
  const close = useSymbolUi((s) => s.close);
  const [mounted, setMounted] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // vaul 用 document 做拖拽和焦点捕获，SSR 阶段不能渲染 Portal。
  // 不加这个门控，窄屏下会白屏。
  useEffect(() => setMounted(true), []);

  // 切路由自动关：抽屉里的股票不再属于当前页，留着会误导
  useEffect(() => {
    close();
  }, [pathname, close]);

  if (!mounted) return null;

  return (
    <Drawer.Root
      open={id != null}
      onOpenChange={(open) => !open && close()}
      // direction 挂在 Root 上，不是 Content —— vaul 的 API 这样定的
      direction="right"
      // 默认会给 body 加缩放，页面宽度会跳一下
      shouldScaleBackground={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-fg/40" />
        <Drawer.Content className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface sm:max-w-md">
          {id ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SymbolPanel id={id} />
            </div>
          ) : null}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
