import { useQuery } from "@tanstack/react-query";
import { Star, X } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtCap, fmtMultiple, fmtPlain, fmtPrice, fmtWan, signedPct, toneClass } from "@/lib/market/format";
import { BOARD_LABEL, limitTag, T1_RECORD, type T1Ticket } from "@/lib/market/model";
import type { Bar, Quote } from "@/lib/market/types";
import { getKline } from "@/lib/market/quotes.functions";
import { HoldNote } from "@/components/screener/stance";

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
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-fg">
      <div className="text-muted">{bar.date}</div>
      <div className={cx("tabular-nums", up ? "text-up" : "text-down")}>收 {bar.c.toFixed(2)}</div>
      <div className="tabular-nums text-muted">
        开 {bar.o.toFixed(2)} · 高 {bar.h.toFixed(2)} · 低 {bar.l.toFixed(2)}
      </div>
    </div>
  );
}

export function Detail({
  quote,
  score,
  reasons,
  idle,
  watched,
  plan,
  holdDays,
  onClose,
  onToggleWatch,
}: {
  quote: Quote;
  score: number | null;
  reasons: string[];
  idle: boolean;
  watched: boolean;
  plan: { headline: string; lines: string[]; ticket: T1Ticket | null; sellDay: string } | null;
  holdDays: number | null;
  onClose: () => void;
  onToggleWatch: () => void;
}) {
  const kline = useQuery({
    queryKey: ["kline", quote.id],
    queryFn: () => getKline({ data: { id: quote.id } }),
    staleTime: 5 * 60_000,
  });
  const bars = kline.data?.bars ?? [];
  const trendUp = bars.length > 1 ? bars[bars.length - 1].c >= bars[0].c : quote.chg != null && quote.chg >= 0;
  const tag = limitTag(quote);
  const stats: { label: string; value: string; tone?: number | null }[] = [
    { label: "市盈率", value: fmtMultiple(quote.pe) },
    { label: "市净率", value: fmtMultiple(quote.pb) },
    { label: "总市值", value: fmtCap(quote.cap) },
    { label: "流通市值", value: fmtCap(quote.floatCap) },
    { label: "换手", value: idle && quote.turnover === 0 ? "—" : `${fmtPlain(quote.turnover, 2)}%` },
    { label: "量比", value: fmtPlain(quote.volRatio, 2, idle) },
    { label: "振幅", value: idle && quote.amp === 0 ? "—" : `${fmtPlain(quote.amp, 2)}%` },
    { label: "成交额", value: fmtWan(quote.amount, idle) },
    { label: "5 日", value: signedPct(quote.d5), tone: quote.d5 },
    { label: "10 日", value: signedPct(quote.d10), tone: quote.d10 },
    { label: "20 日", value: signedPct(quote.d20), tone: quote.d20 },
    { label: "60 日", value: signedPct(quote.d60), tone: quote.d60 },
    { label: "年初至今", value: signedPct(quote.ytd), tone: quote.ytd },
    { label: "主力净流入", value: fmtWan(quote.inflow, idle), tone: idle && quote.inflow === 0 ? null : quote.inflow },
  ];

  return (
    <div className="fixed inset-0 z-40 xl:static xl:z-auto">
      <button
        type="button"
        className="absolute inset-0 bg-fg/40 xl:hidden"
        aria-label="关闭详情"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-line bg-surface xl:static xl:max-w-none xl:border-l">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-4">
          <div className="min-w-0">
            <div className="text-xs text-muted">
              {BOARD_LABEL[quote.board]} · {quote.code}
              {quote.st ? " · ST" : ""}
              {tag ? ` · ${tag}` : ""}
            </div>
            <h2 className="truncate text-xl font-semibold">{quote.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-11 items-center justify-center rounded-md border border-line"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className={cx("text-3xl font-semibold tabular-nums", toneClass(quote.chg))}>
                {fmtPrice(quote.price)}
              </div>
              <div className={cx("tabular-nums", toneClass(quote.chg))}>{signedPct(quote.chg)}</div>
              <div className="mt-2">
                <HoldNote days={holdDays} />
              </div>
            </div>
            <div className="text-right">
              {score != null ? (
                <>
                  <div className="text-xs text-muted">模型得分</div>
                  <div className="text-2xl font-semibold tabular-nums">{score}</div>
                </>
              ) : (
                <div className="text-sm text-muted">未参加当前模型</div>
              )}
            </div>
          </div>
          {reasons.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-fg">
              {reasons.map((reason) => (
                <li key={reason} className="rounded-md bg-surface-2 px-3 py-2">
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
          {plan ? (
            <div className="rounded-lg border border-line bg-bg px-3 py-3 text-sm">
              <p className="font-medium">{plan.headline}</p>
              {plan.ticket ? (
                <dl className="mt-3 grid grid-cols-1 gap-2">
                  <div>
                    <dt className="text-xs text-muted">预期买入价 · 尚未成交</dt>
                    <dd className="text-lg font-medium tabular-nums">{fmtPrice(plan.ticket.buy)}</dd>
                    <dd className="text-pretty text-muted">按现价挂限价，不要高于这个价。还没成交，不是持仓成本。</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">昨收</dt>
                    <dd className="tabular-nums">{fmtPrice(plan.ticket.prev)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">还能买的价格</dt>
                    <dd className="tabular-nums">
                      {fmtPrice(plan.ticket.low)} – {fmtPrice(plan.ticket.high)}
                    </dd>
                    <dd className="text-pretty text-muted">昨收跌 6% 到 2%。现价在这个区间里，规则才成立。</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">涨过这个价就不要买</dt>
                    <dd className="tabular-nums">{fmtPrice(plan.ticket.high)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">跌停价，碰到放弃</dt>
                    <dd className="tabular-nums">{fmtPrice(plan.ticket.limitDown)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">预期卖出价</dt>
                    <dd className="text-lg font-medium tabular-nums">{fmtPrice(plan.ticket.sell)}</dd>
                    <dd className="text-pretty text-muted">
                      买入价加上历史平均毛收益 {T1_RECORD.grossPct}%。不是要提前挂出的目标单，实际到 {plan.sellDay}{" "}
                      收盘附近卖。买入当天不能卖。
                    </dd>
                  </div>
                </dl>
              ) : null}
              {plan.lines.length > 0 && !plan.ticket ? (
                <ul className="mt-2 flex flex-col gap-1 text-muted">
                  {plan.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="h-52">
            {kline.isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">正在取前复权日线</div>
            ) : bars.length < 2 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">走势暂时没有返回</div>
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
            <div className="flex justify-between text-xs tabular-nums text-muted">
              <span>{bars[0].date.slice(5)}</span>
              <span>前复权收盘</span>
              <span>{bars[bars.length - 1].date.slice(5)}</span>
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-2">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-md bg-bg px-3 py-2">
                <dt className="text-xs text-muted">{stat.label}</dt>
                <dd className={cx("tabular-nums", stat.tone != null ? toneClass(stat.tone) : "text-fg")}>
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onToggleWatch}
              className={cx(
                "inline-flex h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium",
                watched ? "bg-fg text-bg" : "border border-line bg-surface text-fg",
              )}
            >
              <Star className="size-4" fill={watched ? "currentColor" : "none"} />
              {watched ? "已在自选" : "加入自选"}
            </button>
            <a
              className="inline-flex h-11 items-center justify-center rounded-md border border-line text-sm"
              href={`https://quote.eastmoney.com/${quote.id}.html`}
              target="_blank"
              rel="noreferrer"
            >
              在东方财富查看这只股票
            </a>
          </div>
          <p className="text-xs text-pretty text-muted">
            {plan
              ? "这是次日卖出的执行约束，不是收益承诺。行情有延迟，下单前再看一次盘口。"
              : "得分只解释这只股票为什么排进来，不是买卖建议。行情来自公开接口，可能有延迟。"}
          </p>
        </div>
      </aside>
    </div>
  );
}
