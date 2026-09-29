import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Star } from "lucide-react";
import { Detail } from "@/components/screener/detail";
import { Stance, HoldNote } from "@/components/screener/stance";
import { Journal } from "@/components/screener/paper";
import { Picks } from "@/components/screener/picks";
import { fmtCap, fmtMultiple, fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import {
  BOARD_LABEL,
  STRATEGIES,
  compareMetric,
  defaultDir,
  emptyFilters,
  evaluate,
  filtersDirty,
  isIdleBook,
  limitTag,
  passesFilters,
  type Filters,
  type SortKey,
  type StrategyId,
} from "@/lib/market/model";
import { formatClock, sessionPhase } from "@/lib/market/session";
import type { Board, IndexQuote, Quote, SessionInfo, Universe } from "@/lib/market/types";
import { getIndices, getUniverse } from "@/lib/market/quotes.functions";
import { useWatch } from "@/lib/watchlist";
import type { PaperDay } from "@/lib/paper";

const BOARDS: Board[] = ["sh", "sz", "cyb", "kcb"];
const INDEX_LABEL: Record<string, string> = {
  sh000300: "沪深300",
  sh000001: "上证",
  sz399001: "深成",
  sz399006: "创业",
  sh000688: "科创",
};
const SORTS: { id: SortKey; label: string }[] = [
  { id: "score", label: "模型得分" },
  { id: "chg", label: "今日涨跌" },
  { id: "pe", label: "市盈率" },
  { id: "pb", label: "市净率" },
  { id: "cap", label: "总市值" },
  { id: "d20", label: "20 日涨跌" },
  { id: "d60", label: "60 日涨跌" },
  { id: "ytd", label: "年初至今" },
  { id: "inflow", label: "主力净流入" },
  { id: "turnover", label: "换手率" },
  { id: "volRatio", label: "量比" },
];

const field =
  "h-11 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-fg";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type ScreenerInitial = {
  universe: Universe | null;
  indices: IndexQuote[];
  journal: PaperDay[];
  error: string | null;
  phase: SessionInfo;
};

type Row = { quote: Quote; score: number | null; reasons: string[] };

function metricOf(row: Row, key: SortKey): number | null {
  const quote = row.quote;
  switch (key) {
    case "score":
      return row.score;
    case "chg":
      return quote.chg;
    case "pe":
      return quote.pe;
    case "pb":
      return quote.pb;
    case "cap":
      return quote.cap;
    case "d20":
      return quote.d20;
    case "d60":
      return quote.d60;
    case "ytd":
      return quote.ytd;
    case "inflow":
      return quote.inflow;
    case "turnover":
      return quote.turnover;
    case "volRatio":
      return quote.volRatio;
  }
}

function FiltersForm({
  filters,
  idle,
  onChange,
}: {
  filters: Filters;
  idle: boolean;
  onChange: (patch: Partial<Filters>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 text-xs text-muted">板块</div>
        <div className="flex flex-wrap gap-2">
          {BOARDS.map((board) => {
            const on = filters.boards.includes(board);
            return (
              <button
                key={board}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    boards: on ? filters.boards.filter((item) => item !== board) : [...filters.boards, board],
                  })
                }
                className={cx(
                  "h-10 rounded-full border px-3 text-sm",
                  on ? "border-fg bg-fg text-bg" : "border-line bg-surface text-fg",
                )}
              >
                {BOARD_LABEL[board]}
              </button>
            );
          })}
        </div>
      </div>
      <label className="flex h-11 items-center justify-between gap-3 text-sm">
        <span>剔除 ST 和退市</span>
        <input
          type="checkbox"
          className="size-4 accent-fg"
          checked={filters.excludeSt}
          onChange={(event) => onChange({ excludeSt: event.target.checked })}
        />
      </label>
      <Range label="市盈率" min={filters.peMin} max={filters.peMax} onMin={(peMin) => onChange({ peMin })} onMax={(peMax) => onChange({ peMax })} />
      <Range label="市净率" min={filters.pbMin} max={filters.pbMax} onMin={(pbMin) => onChange({ pbMin })} onMax={(pbMax) => onChange({ pbMax })} />
      <Range label="总市值（亿）" min={filters.capMin} max={filters.capMax} onMin={(capMin) => onChange({ capMin })} onMax={(capMax) => onChange({ capMax })} />
      <Range label="今日涨跌幅 %" min={filters.chgMin} max={filters.chgMax} onMin={(chgMin) => onChange({ chgMin })} onMax={(chgMax) => onChange({ chgMax })} />
      <Range label="20 日涨跌幅 %" min={filters.d20Min} max={filters.d20Max} onMin={(d20Min) => onChange({ d20Min })} onMax={(d20Max) => onChange({ d20Max })} />
      <Range label="60 日涨跌幅 %" min={filters.d60Min} max={filters.d60Max} onMin={(d60Min) => onChange({ d60Min })} onMax={(d60Max) => onChange({ d60Max })} />
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted">换手率下限 %</span>
        <input
          className={field}
          inputMode="decimal"
          placeholder={idle ? "开盘后生效" : "例如 3"}
          disabled={idle}
          value={filters.hslMin}
          onChange={(event) => onChange({ hslMin: event.target.value })}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-muted">主力净流入下限（万元）</span>
        <input
          className={field}
          inputMode="decimal"
          placeholder={idle ? "开盘后生效" : "例如 3000"}
          disabled={idle}
          value={filters.inflowMin}
          onChange={(event) => onChange({ inflowMin: event.target.value })}
        />
      </label>
    </div>
  );
}

function Range({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: string;
  max: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <input className={field} inputMode="decimal" placeholder="最小" value={min} onChange={(event) => onMin(event.target.value)} />
        <input className={field} inputMode="decimal" placeholder="最大" value={max} onChange={(event) => onMax(event.target.value)} />
      </div>
    </div>
  );
}

export function Screener({ initial }: { initial: ScreenerInitial }) {
  const [universe, setUniverse] = useState(initial.universe);
  const [indices, setIndices] = useState(initial.indices);
  const [error, setError] = useState(initial.error);
  const [phase, setPhase] = useState(initial.phase);
  const [refreshing, setRefreshing] = useState(false);
  const strategy = "early" as StrategyId;
  const [filters, setFilters] = useState<Filters>(() => emptyFilters());
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [tab, setTab] = useState<"scan" | "watch">("scan");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visible, setVisible] = useState(24);
  const ids = useWatch((state) => state.ids);
  const toggleWatch = useWatch((state) => state.toggle);

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      const [nextUniverse, nextIndices] = await Promise.all([
        getUniverse({ data: { refresh: force } }),
        getIndices(),
      ]);
      setUniverse(nextUniverse);
      setIndices(nextIndices);
      setError(nextUniverse.stale ? "行情源不稳定，先显示上一轮数据" : null);
      setPhase(sessionPhase());
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void useWatch.persist.rehydrate();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setPhase(sessionPhase()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!phase.open) return;
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [phase.open, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const quotes = universe?.quotes ?? [];
  const idle = isIdleBook(quotes);
  const live = !idle;
  const tail = phase.tail;
  const meta = STRATEGIES.find((item) => item.id === strategy) ?? STRATEGIES[0];

  const ranked = useMemo(() => {
    const pool = tab === "watch" ? quotes.filter((quote) => ids.includes(quote.id)) : quotes;
    const rows: Row[] = [];
    for (const quote of pool) {
      if (!passesFilters(quote, filters, idle)) continue;
      const scored = strategy === "custom" ? null : evaluate(strategy, quote, live, strategy === "early" ? true : phase.sealed || tail);
      if (tab === "scan" && strategy !== "custom" && !scored) continue;
      rows.push({
        quote,
        score: scored?.score ?? null,
        reasons: scored?.reasons ?? [],
      });
    }
    rows.sort(
      (a, b) => compareMetric(metricOf(a, sortKey), metricOf(b, sortKey), sortDir) || b.quote.cap - a.quote.cap,
    );
    return rows;
  }, [quotes, ids, tab, filters, idle, live, tail, phase.sealed, strategy, sortKey, sortDir]);

  const shown = ranked.slice(0, visible);
  const selected = quotes.find((quote) => quote.id === selectedId) ?? null;
  const selectedRow = ranked.find((row) => row.quote.id === selectedId);
  const top = tab === "scan" ? ranked[0] : undefined;
  const indexTime = indices.find((item) => item.time)?.time;

  function patchFilters(patch: Partial<Filters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setVisible(24);
  }

  return (
    <div className="min-h-screen">
      <div className="h-1 bg-up" />
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 md:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-serif text-xs tracking-widest text-muted">CHI HENG</p>
              <h1 className="text-3xl font-semibold leading-none">赤衡</h1>
              <p className="mt-2 text-sm text-pretty text-muted">只留启动前期。持股 5 到 10 天。记满 60 个交易日前，默认空仓。</p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="text-right text-sm">
                <div className="font-medium">{phase.label}</div>
                <div className="tabular-nums text-muted">{indexTime ? `指数 ${indexTime}` : formatClock(universe?.asOf ?? Date.now())}</div>
              </div>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={refreshing}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-fg px-4 text-sm font-medium text-bg disabled:opacity-60"
              >
                <RefreshCw className={cx("size-4", refreshing && "animate-spin")} />
                刷新行情
              </button>
            </div>
          </div>
          {indices.length > 0 ? (
            <div className="flex w-full min-w-0 gap-2 overflow-x-auto scroll-slim">
              {indices.map((item) => (
                <div key={item.id} className="min-w-36 shrink-0 rounded-lg border border-line bg-surface px-3 py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                    <span className={cx("text-xs tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
                  </div>
                  <div className="text-lg font-medium tabular-nums">{fmtPrice(item.price)}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">指数暂时没有返回。</p>
          )}
        </div>
      </header>

      <main className="mx-auto grid min-w-0 max-w-7xl grid-cols-1 gap-4 px-4 py-4 md:px-6 lg:grid-cols-12">
        <section className="min-w-0 lg:col-span-12">
          <p className="max-w-3xl text-sm text-pretty text-muted">{meta.hint}</p>
          <div className="mt-3">
            <Stance phase={phase} strategy={strategy} />
          </div>
          <Journal
            quotes={quotes}
            live={live}
            sealed={phase.sealed}
            date={phase.date}
            signalTime={formatClock(Date.now())}
            bookReady={Boolean(universe && !universe.stale && !universe.partial)}
            indexPrice={indices.find((item) => item.id === "sh000300")?.price ?? null}
          />
          {strategy === "t1" && !live ? (
            <p className="mt-2 max-w-3xl text-sm text-pretty text-fg">开盘前没有今天的成交，这套已停用的门槛也不会变成可以买的名单。</p>
          ) : idle ? (
            <p className="mt-2 max-w-3xl text-sm text-pretty text-fg">
              现在几乎没有成交。换手、量比、成交额和主力净流入先不参与硬性筛选，排序主要看估值和 5/20/60 日涨跌。开盘后会自动计入。
            </p>
          ) : null}
          {universe?.partial ? (
            <p className="mt-2 text-sm text-up">科创板这一轮没有合上，列表暂时只有沪深主板和创业板。</p>
          ) : null}
          {error ? <p className="mt-2 text-sm text-up">{error}</p> : null}
        </section>

        <aside className="hidden lg:col-span-3 lg:block">
          <div className="sticky top-4 rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">再收窄</h2>
              {filtersDirty(filters) ? (
                <button type="button" className="text-sm text-muted" onClick={() => patchFilters(emptyFilters())}>
                  清空
                </button>
              ) : null}
            </div>
            <FiltersForm filters={filters} idle={idle} onChange={patchFilters} />
          </div>
        </aside>

        <section className="min-w-0 lg:col-span-9">
          <Picks
            date={phase.date}
            quotes={quotes}
            picks={ranked.slice(0, 3).map((row) => ({ quote: row.quote, reasons: row.reasons }))}
            serverDays={initial.journal}
            onOpen={setSelectedId}
          />
          <details className="mb-3 rounded-lg border border-line bg-surface lg:hidden">
            <summary className="flex h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-medium">
              筛选条件
              <span className="text-muted">{filtersDirty(filters) ? "已修改" : "默认"}</span>
            </summary>
            <div className="border-t border-line px-4 py-4">
              <FiltersForm filters={filters} idle={idle} onChange={patchFilters} />
              {filtersDirty(filters) ? (
                <button type="button" className="mt-4 text-sm text-muted" onClick={() => patchFilters(emptyFilters())}>
                  清空筛选
                </button>
              ) : null}
            </div>
          </details>

          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex rounded-md border border-line bg-surface p-1">
              <button
                type="button"
                onClick={() => setTab("scan")}
                className={cx("h-10 rounded px-4 text-sm", tab === "scan" ? "bg-fg text-bg" : "text-fg")}
              >
                选股
              </button>
              <button
                type="button"
                onClick={() => setTab("watch")}
                className={cx("h-10 rounded px-4 text-sm", tab === "watch" ? "bg-fg text-bg" : "text-fg")}
              >
                自选 {ids.length > 0 ? ids.length : ""}
              </button>
            </div>
            <div className="flex flex-1 items-center gap-2 sm:max-w-sm">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">搜索代码或名称</span>
                <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted" />
                <input
                  className={cx(field, "pl-10")}
                  placeholder="代码或名称"
                  value={filters.q}
                  onChange={(event) => patchFilters({ q: event.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              {universe ? (
                <>
                  全市场 {universe.total} 只
                  {tab === "scan" ? ` · 通过 ${ranked.length} 只` : ` · 自选里 ${ranked.length} 只`}
                  {universe.asOf ? <span className="text-muted"> · 更新于 {formatClock(universe.asOf)}</span> : null}
                </>
              ) : (
                "还没有行情"
              )}
            </p>
            <div className="flex items-center gap-2">
              <label className="sr-only" htmlFor="sort-key">
                排序
              </label>
              <select
                id="sort-key"
                className="h-10 rounded-md border border-line bg-surface px-2 text-sm"
                value={sortKey}
                onChange={(event) => {
                  const key = event.target.value as SortKey;
                  setSortKey(key);
                  setSortDir(defaultDir(key));
                }}
              >
                {SORTS.filter((item) => strategy !== "custom" || item.id !== "score").map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="h-10 rounded-md border border-line bg-surface px-3 text-sm"
                onClick={() => setSortDir((dir) => (dir === "desc" ? "asc" : "desc"))}
              >
                {sortDir === "desc" ? "从高到低" : "从低到高"}
              </button>
            </div>
          </div>

          {tab === "scan" && top && strategy !== "custom" ? (
            <button
              type="button"
              onClick={() => setSelectedId(top.quote.id)}
              className="mb-3 w-full rounded-lg border border-line bg-surface px-4 py-3 text-left"
            >
              <div className="text-xs text-muted">
                观察名单里最靠前的一只，不是买入理由
              </div>
              <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-lg font-semibold">
                  {top.quote.name}
                  <span className="ml-2 text-sm font-normal text-muted">{top.quote.code}</span>
                </div>
                <div className="tabular-nums">
                  <span className="mr-3 text-muted">得分 {top.score}</span>
                  <span className={toneClass(top.quote.chg)}>{signedPct(top.quote.chg)}</span>
                </div>
              </div>
              {top.reasons[0] ? <p className="mt-1 text-sm text-muted">{top.reasons.join(" · ")}</p> : null}
              <div className="mt-2">
                <HoldNote compact days={null} />
              </div>
            </button>
          ) : null}

          {!universe && error ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-10 text-center">
              <p className="text-sm">{error}</p>
              <button
                type="button"
                onClick={() => void refresh(true)}
                className="mt-4 inline-flex h-11 items-center rounded-md bg-fg px-4 text-sm text-bg"
              >
                再试一次
              </button>
            </div>
          ) : ranked.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
              {tab === "watch"
                ? "自选还是空的。在选股列表里点星标，会留在这台浏览器上。"
                : strategy === "t1"
                  ? "这套已停用。没有要买的股票，保持空仓。"
                  : "现在没有刚启动、又还没走远的股票。可以空仓。"}
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2 md:hidden">
                {shown.map((row) => (
                  <li key={row.quote.id}>
                    <QuoteCard
                      row={row}
                      holdDays={null}
                      watched={ids.includes(row.quote.id)}
                      onOpen={() => setSelectedId(row.quote.id)}
                      onToggle={() => toggleWatch(row.quote.id)}
                    />
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface md:block">
                <table className="w-full border-collapse text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="px-3 py-3 font-medium">名称</th>
                      <th className="px-3 py-3 text-right font-medium">现价</th>
                      <th className="px-3 py-3 text-right font-medium">涨跌</th>
                      {strategy !== "custom" ? <th className="px-3 py-3 text-right font-medium">得分</th> : null}
                      <th className="px-3 py-3 text-right font-medium">市盈</th>
                      <th className="hidden px-3 py-3 text-right font-medium lg:table-cell">市净</th>
                      <th className="px-3 py-3 text-right font-medium">市值</th>
                      <th className="hidden px-3 py-3 text-right font-medium xl:table-cell">20 日</th>
                      <th className="hidden px-3 py-3 font-medium xl:table-cell">入选理由</th>
                      <th className="px-2 py-3 font-medium">
                        <span className="sr-only">自选</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => {
                      const tag = limitTag(row.quote);
                      return (
                        <tr
                          key={row.quote.id}
                          className={cx(
                            "cursor-pointer border-b border-line last:border-0 hover:bg-surface-2",
                            selectedId === row.quote.id && "bg-surface-2",
                          )}
                          onClick={() => setSelectedId(row.quote.id)}
                        >
                          <td className="px-3 py-3">
                            <div className="font-medium">{row.quote.name}</div>
                            <div className="text-xs text-muted">
                              {row.quote.code} · {BOARD_LABEL[row.quote.board]}
                              {tag ? ` · ${tag}` : ""}
                              {row.quote.st ? " · ST" : ""}
                            </div>
                            <HoldNote compact days={null} />
                          </td>
                          <td className={cx("px-3 py-3 text-right tabular-nums", toneClass(row.quote.chg))}>
                            {fmtPrice(row.quote.price)}
                          </td>
                          <td className={cx("px-3 py-3 text-right tabular-nums", toneClass(row.quote.chg))}>
                            {signedPct(row.quote.chg)}
                          </td>
                          {strategy !== "custom" ? (
                            <td className="px-3 py-3 text-right font-medium tabular-nums">{row.score ?? "—"}</td>
                          ) : null}
                          <td className="px-3 py-3 text-right tabular-nums">{fmtMultiple(row.quote.pe)}</td>
                          <td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
                            {fmtMultiple(row.quote.pb)}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{fmtCap(row.quote.cap)}</td>
                          <td className={cx("hidden px-3 py-3 text-right tabular-nums xl:table-cell", toneClass(row.quote.d20))}>
                            {signedPct(row.quote.d20, 1)}
                          </td>
                          <td className="hidden max-w-56 truncate px-3 py-3 text-muted xl:table-cell">
                            {row.reasons[0] ?? "—"}
                          </td>
                          <td className="px-2 py-3">
                            <button
                              type="button"
                              aria-label={ids.includes(row.quote.id) ? "移出自选" : "加入自选"}
                              className="inline-flex size-11 items-center justify-center"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleWatch(row.quote.id);
                              }}
                            >
                              <Star className="size-4" fill={ids.includes(row.quote.id) ? "currentColor" : "none"} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {visible < ranked.length ? (
                <button
                  type="button"
                  className="mt-3 h-11 w-full rounded-md border border-line bg-surface text-sm"
                  onClick={() => setVisible((count) => count + 24)}
                >
                  再看 24 只 · 还有 {ranked.length - visible} 只
                </button>
              ) : null}
            </>
          )}
          <p className="mt-4 text-xs text-pretty text-muted">
            覆盖沪市、深市、创业板和科创板，北证暂未纳入。默认建议是空仓。节假日未单独排除。数据有延迟，赤衡不是投资顾问。
          </p>
        </section>
      </main>

      {selected ? (
        <div className="xl:fixed xl:inset-y-0 xl:right-0 xl:z-40 xl:flex xl:w-96">
          <Detail
            quote={selected}
            score={selectedRow?.score ?? (strategy === "custom" ? null : evaluate(strategy, selected, live, tail)?.score ?? null)}
            reasons={
              selectedRow?.reasons ??
              (strategy === "custom" ? [] : (evaluate(strategy, selected, live, tail)?.reasons ?? []))
            }
            plan={
              strategy === "t1"
                ? {
                    headline: "不要按这只股票下单。",
                    lines: ["次日卖出已停用。这里不再给预期买入价和预期卖出价。"],
                    ticket: null,
                    sellDay: phase.nextSell,
                  }
                : null
            }
            idle={idle}
            holdDays={null}
            watched={ids.includes(selected.id)}
            onClose={() => setSelectedId(null)}
            onToggleWatch={() => toggleWatch(selected.id)}
          />
        </div>
      ) : null}
    </div>
  );
}

function QuoteCard({
  row,
  watched,
  holdDays,
  onOpen,
  onToggle,
}: {
  row: Row;
  watched: boolean;
  holdDays: number | null;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const tag = limitTag(row.quote);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <button type="button" onClick={onOpen} className="block w-full px-3 py-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{row.quote.name}</div>
            <div className="text-xs text-muted">
              {row.quote.code} · {BOARD_LABEL[row.quote.board]}
              {tag ? ` · ${tag}` : ""}
            </div>
          </div>
          <div className="text-right">
            <div className={cx("tabular-nums", toneClass(row.quote.chg))}>{fmtPrice(row.quote.price)}</div>
            <div className={cx("text-sm tabular-nums", toneClass(row.quote.chg))}>{signedPct(row.quote.chg)}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {row.score != null ? <span className="text-fg">得分 {row.score}</span> : null}
          <span>市盈 {fmtMultiple(row.quote.pe)}</span>
          <span>市值 {fmtCap(row.quote.cap)}</span>
          <span className={toneClass(row.quote.d20)}>20 日 {signedPct(row.quote.d20, 1)}</span>
        </div>
        <div className="mt-2">
          <HoldNote compact days={holdDays} />
        </div>
        {row.reasons[0] ? <p className="mt-2 text-xs text-pretty text-muted">{row.reasons[0]}</p> : null}
      </button>
      <div className="border-t border-line px-2">
        <button type="button" onClick={onToggle} className="inline-flex h-11 items-center gap-2 px-2 text-sm">
          <Star className="size-4" fill={watched ? "currentColor" : "none"} />
          {watched ? "移出自选" : "加入自选"}
        </button>
      </div>
    </div>
  );
}
