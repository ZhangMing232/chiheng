import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Detail } from "@/components/screener/detail";
import { Journal } from "@/components/screener/paper";
import { Picks } from "@/components/screener/picks";
import { PrefsBar } from "@/components/screener/prefs-bar";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { isIdleBook } from "@/lib/market/model";
import { quoteOrder } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { getIndices, getUniverse, savePrefs } from "@/lib/market/quotes.functions";
import { formatClock, sessionPhase } from "@/lib/market/session";
import type { IndexQuote, Quote, SessionInfo, Universe } from "@/lib/market/types";
import type { PaperDay } from "@/lib/paper";
import type { EarlyRules } from "@/lib/market/rules";

const INDEX_LABEL: Record<string, string> = {
  sh510300: "沪深300ETF",
  sh000300: "沪深300",
  sh000001: "上证",
  sz399001: "深成",
  sz399006: "创业",
  sh000688: "科创",
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type ScreenerInitial = {
  universe: Universe | null;
  indices: IndexQuote[];
  journal: PaperDay[];
  rules: EarlyRules;
  prefs: Prefs;
  error: string | null;
  phase: SessionInfo;
};

export function Screener({ initial }: { initial: ScreenerInitial }) {
  const [universe, setUniverse] = useState(initial.universe);
  const [indices, setIndices] = useState(initial.indices);
  const [error, setError] = useState(initial.error);
  const [phase, setPhase] = useState(initial.phase);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(initial.prefs);
  const rules = initial.rules;

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
    const timer = window.setInterval(() => setPhase(sessionPhase()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!phase.open) return;
    const timer = window.setInterval(() => void refresh(false), 60_000);
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
  const live = !isIdleBook(quotes);
  const ranked = useMemo(() => {
    const rows: { quote: Quote; score: number; reasons: string[]; buy: number; sell: number; stop: number; hit: boolean }[] = [];
    for (const quote of quotes) {
      const order = quoteOrder(prefs.style, quote, rules);
      if (!order || !matchPrefs(quote, prefs)) continue;
      rows.push({
        quote,
        score: order.score,
        reasons: order.reasons,
        buy: order.buy,
        sell: order.sell,
        stop: order.stop,
        hit: order.hit,
      });
    }
    rows.sort((a, b) => b.score - a.score || b.quote.cap - a.quote.cap);
    return rows;
  }, [quotes, live, rules, prefs]);

  const selected = quotes.find((quote) => quote.id === selectedId) ?? null;
  const selectedRow = ranked.find((row) => row.quote.id === selectedId);
  const indexTime = indices.find((item) => item.time)?.time;

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="mb-3 h-1 w-10 rounded-full bg-up" />
              <h1 className="font-serif text-4xl leading-none font-semibold tracking-tight">赤衡</h1>
              <p className="mt-3 max-w-sm text-sm text-pretty text-muted">选一套策略。现价打到买入价才买入并开始追踪，打到卖出价再卖。</p>
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
                className="inline-flex h-11 items-center gap-2 rounded-full bg-fg px-4 text-sm font-medium text-bg disabled:opacity-60"
              >
                <RefreshCw className={cx("size-4", refreshing && "animate-spin")} />
                刷新
              </button>
            </div>
          </div>
          {indices.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto scroll-slim pb-1">
              {indices.map((item) => (
                <div
                  key={item.id}
                  className={cx(
                    "min-w-32 shrink-0 rounded-2xl px-3 py-2",
                    item.pct >= 0 ? "bg-up-soft" : "bg-down-soft",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                    <span className={cx("text-xs tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
                  </div>
                  <div className={cx("text-lg font-medium tabular-nums", toneClass(item.pct))}>{fmtPrice(item.price)}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-6">
        <Journal
          quotes={quotes}
          live={live}
          sealed={phase.sealed}
          date={phase.date}
          signalTime={formatClock(Date.now())}
          bookReady={Boolean(universe && !universe.stale && !universe.partial)}
          indexPrice={indices.find((item) => item.id === "sh000300")?.price ?? null}
          rules={rules}
          prefs={prefs}
        />
        {error ? <p className="text-sm text-up">{error}</p> : null}
        <PrefsBar
          prefs={prefs}
          onChange={(next) => {
            setPrefs(next);
            void savePrefs({ data: next }).catch(() => setError("偏好没保存上，刷新后会回到上次的选择"));
          }}
        />
        <Picks
          date={phase.date}
          quotes={quotes}
          picks={ranked.slice(0, 3).map((row) => ({
            quote: row.quote,
            reasons: row.reasons,
            buy: row.buy,
            sell: row.sell,
            stop: row.stop,
            hit: row.hit,
          }))}
          serverDays={initial.journal}
          rules={rules}
          style={prefs.style}
          marketOpen={phase.open}
          tail={phase.tail}
          benchmark={null}
          onOpen={setSelectedId}
        />
      </main>
      {selected ? (
        <Detail
          quote={selected}
          score={selectedRow?.score ?? null}
          reasons={selectedRow?.reasons ?? []}
          idle={!live}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}
