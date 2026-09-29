import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Detail } from "@/components/screener/detail";
import { Journal } from "@/components/screener/paper";
import { Picks } from "@/components/screener/picks";
import { PrefsBar } from "@/components/screener/prefs-bar";
import { TopNav } from "@/components/screener/nav";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { isIdleBook } from "@/lib/market/model";
import { watchList, type Listed } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { getIndices, getRelay, getUniverse, savePrefs } from "@/lib/market/quotes.functions";
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
  const [relay, setRelay] = useState<Listed[]>([]);
  const rules = initial.rules;

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      const [nextUniverse, nextIndices, nextRelay] = await Promise.all([
        getUniverse({ data: { refresh: force } }),
        getIndices(),
        getRelay().catch(() => [] as Listed[]),
      ]);
      setUniverse(nextUniverse);
      setIndices(nextIndices);
      setRelay(nextRelay);
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
    const pull = () => void getRelay().then(setRelay).catch(() => undefined);
    pull();
    const timer = window.setInterval(pull, 60_000);
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
    if (prefs.style === "relay") return relay.filter((row) => matchPrefs(row.quote, prefs));
    return watchList(quotes, prefs.style, rules, (quote) => matchPrefs(quote, prefs));
  }, [quotes, rules, prefs, relay]);

  const selected = quotes.find((quote) => quote.id === selectedId) ?? null;
  const selectedRow = ranked.find((row) => row.quote.id === selectedId);
  const indexTime = indices.find((item) => item.time)?.time;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <h1 className="font-serif text-2xl leading-none font-semibold tracking-tight">赤衡</h1>
              <TopNav />
              <p className="mt-1 truncate text-xs text-muted">五套分开记账。打到买入价才记，打到卖出价或止损价再卖。</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="text-right text-xs leading-4">
                <div className="font-medium">{phase.label}</div>
                <div className="tabular-nums text-muted">{indexTime ? `指数 ${indexTime}` : formatClock(universe?.asOf ?? Date.now())}</div>
              </div>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={refreshing}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-3 text-sm text-bg disabled:opacity-60"
              >
                <RefreshCw className={cx("size-3.5", refreshing && "animate-spin")} />
                刷新
              </button>
            </div>
          </div>
          {indices.length > 0 ? (
            <div className="flex gap-4 overflow-x-auto scroll-slim border-t border-line py-2">
              {indices.map((item) => (
                <div key={item.id} className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                  <span className={cx("text-sm font-medium tabular-nums", toneClass(item.pct))}>{fmtPrice(item.price)}</span>
                  <span className={cx("text-xs tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
        <Journal
          quotes={quotes}
          live={live}
          matching={phase.matching}
          date={phase.date}
          signalTime={formatClock(Date.now())}
          bookReady={Boolean(universe && !universe.stale && !universe.partial)}
          indexPrice={indices.find((item) => item.id === "sh000300")?.price ?? null}
          rules={rules}
          prefs={prefs}
          relay={relay}
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
          picks={ranked.map((row) => ({
            quote: row.quote,
            reasons: row.reasons,
            buy: row.buy,
            sell: row.sell,
            stop: row.stop,
            hit: row.hit,
            block: row.block,
          }))}
          serverDays={initial.journal}
          rules={rules}
          style={prefs.style}
          marketOpen={phase.open}
          tailHalf={phase.tailHalf}
          pause={phase.label}
          benchmark={null}
          onStyle={(style) => {
            const next = { ...prefs, style };
            setPrefs(next);
            void savePrefs({ data: next }).catch(() => setError("偏好没保存上，刷新后会回到上次的选择"));
          }}
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
