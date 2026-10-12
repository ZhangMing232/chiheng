/**
 * 这个文件是干什么的：
 * 个股抽屉。点任意股票名从右侧滑出，显示行情、所属策略、相关消息、资金流。
 *
 * 你需要知道的：
 * 1. **它由 store 驱动，不由父组件传参**。原来的 `Detail` 收 `quote`/`score`/`reasons`
 *    四个 prop，只能活在选股页里（那里才有 quote 和模型得分）。PPT 要求「点任意股票名
 *    滑出抽屉、不离开当前页」，所以数据改成自己取：行情/持仓/消息/资金流走
 *    `getSymbolPanel`，走势走 `getKline`。
 * 2. **模型得分和入选理由是选股页额外给的**（store 的 `note`）。别的页面不知道这两个
 *    数——它们只看得到行情和账本——所以拿不到就显示「未参加当前模型」，不能编一个。
 * 3. **这里只展示，不买入、不改账。** 行情有延迟。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState, Link } from "@tanstack/react-router";
import { Drawer } from "vaul";
import { X } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fmtCap,
  fmtMultiple,
  fmtPlain,
  fmtPrice,
  fmtWan,
  signedPct,
  toneClass,
} from "@/lib/market/format";
import { BOARD_LABEL, limitTag } from "@/lib/market/model";
import type { Bar, Board } from "@/lib/market/types";
import { getKline, getHolders, getLifts } from "@/lib/market/quotes.functions";
import { getSymbolPanel } from "@/lib/market/symbol-panel.functions";
import { useSymbolUi } from "@/lib/ui/symbol-store";
import { StateBlock } from "@/components/state-block";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Tip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Bar }>;
}) {
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;
  const up = bar.c >= bar.o;
  return (
    <div className="rounded border border-line bg-surface px-3 py-2 text-xs text-fg">
      <div className="text-muted">{bar.date}</div>
      <div className={cx("tabular-nums", up ? "text-up" : "text-down")}>收 {bar.c.toFixed(2)}</div>
      <div className="tabular-nums text-muted">
        开 {bar.o.toFixed(2)} · 高 {bar.h.toFixed(2)} · 低 {bar.l.toFixed(2)}
      </div>
    </div>
  );
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

/**
 * sh600519 → "sh"，给 BOARD_LABEL 查。BOARD_LABEL 的键是 Board（sh/sz/cyb/kcb/bj）
 * 不是中文板块名——查错了 TS 会直接报索引越界。
 */
function boardOf(id: string): Board {
  if (id.startsWith("sh")) return "sh";
  if (id.startsWith("bj")) return "bj";
  return "sz";
}

function SymbolPanel({ id }: { id: string }) {
  const note = useSymbolUi((s) => s.note);
  const panel = useQuery({
    queryKey: ["symbol-panel", id],
    queryFn: () => getSymbolPanel({ data: { id } }),
    staleTime: 60_000,
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
  });
  const lifts = useQuery({
    queryKey: ["lifts", id],
    queryFn: () => getLifts({ data: { id } }),
    staleTime: 60 * 60_000,
    retry: false,
  });

  if (panel.isLoading) {
    return (
      <>
        <PanelHeader id={id} name={null} tag={null} />
        <div className="p-6 text-sm text-muted">正在取这只票的行情和持仓</div>
      </>
    );
  }
  if (panel.isError) {
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

  const data = panel.data;
  const quote = data?.quote ?? null;
  const bars = kline.data?.bars ?? [];
  const trendUp =
    bars.length > 1 ? bars[bars.length - 1].c >= bars[0].c : quote?.chg != null && quote.chg >= 0;
  const score = note?.score ?? null;
  const reasons = note?.reasons ?? [];
  const book = data?.book ?? null;

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
      <PanelHeader id={id} name={quote?.name ?? null} tag={quote ? limitTag(quote) : null} />
      <div className="flex flex-col gap-4 px-3 py-3">
        {/* 价格 + 模型得分 */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <div
              className={cx(
                "text-3xl font-medium tabular-nums",
                quote ? toneClass(quote.chg) : "text-muted",
              )}
            >
              {quote ? fmtPrice(quote.price) : "—"}
            </div>
            <div className={cx("tabular-nums", quote ? toneClass(quote.chg) : "text-muted")}>
              {quote ? signedPct(quote.chg) : "取不到现价"}
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
                未参加当前模型
                <br />
                只有选股页能给得分
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

        {/* 所属策略：持仓状态 + 那一笔的数 */}
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

        {/* 筹码与解禁：户数变化看筹码发散/集中，解禁表是未来的抛压日历（D4） */}
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

        {/* 走势 */}
        <div className="h-52">
          {kline.isLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              正在取前复权日线
            </div>
          ) : bars.length < 2 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              走势暂时没有返回
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={bars} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis dataKey="date" hide />
                <YAxis hide domain={["auto", "auto"]} />
                <Tooltip content={<Tip />} />
                <Area
                  type="monotone"
                  dataKey="c"
                  stroke={trendUp ? "var(--color-up)" : "var(--color-down)"}
                  fill={trendUp ? "var(--color-up)" : "var(--color-down)"}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        {bars.length > 1 ? (
          <div className="-mt-2 flex justify-between text-xs tabular-nums text-muted">
            <span>{bars[0].date.slice(5)}</span>
            <span>前复权收盘</span>
            <span>{bars[bars.length - 1].date.slice(5)}</span>
          </div>
        ) : null}

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

        {/* 资金流 */}
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

        {/* 相关消息 */}
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

        {data?.why ? (
          <p className="text-[11px] leading-relaxed text-muted">说明：{data.why}</p>
        ) : null}

        <div className="flex flex-col gap-2">
          <Link
            to="/symbol"
            search={{ q: id.replace(/^(sh|sz|bj)/, "") }}
            className="inline-flex h-11 items-center justify-center rounded border border-line text-sm hover:bg-surface-2"
          >
            打开个股页（带完整历史）
          </Link>
          <a
            className="inline-flex h-11 items-center justify-center rounded border border-line text-sm"
            href={`https://quote.eastmoney.com/${id}.html`}
            target="_blank"
            rel="noreferrer"
          >
            在东方财富查看这只股票
          </a>
          <p className="text-xs text-pretty text-muted">行情有延迟，不是买卖指令。</p>
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
