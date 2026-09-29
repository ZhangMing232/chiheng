import { useCallback, useEffect, useMemo, useState } from "react";
import { Detail } from "@/components/screener/detail";
import { Journal } from "@/components/screener/paper";
import { Picks } from "@/components/screener/picks";
import { PrefsBar } from "@/components/screener/prefs-bar";
import { Frame } from "@/components/screener/nav";
import { signedPct, toneClass } from "@/lib/market/format";
import { isIdleBook } from "@/lib/market/model";
import { watchList, type Listed } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { getIndices, getRecorder, getRelay, getServerJournal, getUniverse, savePrefs } from "@/lib/market/quotes.functions";
import { formatClock, sessionPhase } from "@/lib/market/session";
import type { IndexQuote, Quote, SessionInfo, Universe } from "@/lib/market/types";
import type { PaperDay } from "@/lib/paper";
import type { EarlyRules } from "@/lib/market/rules";

function RecordLine({ at, ok, now }: { at: number | null; ok: boolean; now: number }) {
  if (at == null) return <span>还没有记账</span>;
  const stale = now - at > 3 * 60_000;
  const clock = formatClock(at);
  if (!ok) return <span className="text-up">记账失败 {clock}</span>;
  if (stale) return <span className="text-up">记账中断 {clock}</span>;
  return <span className="tabular-nums">上次记账 {clock}</span>;
}

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
  recorder: { at: number | null; ok: boolean };
  error: string | null;
  phase: SessionInfo;
};

export function Screener({ initial }: { initial: ScreenerInitial }) {
  const [universe, setUniverse] = useState(initial.universe);
  const [indices, setIndices] = useState(initial.indices);
  const [error, setError] = useState(initial.error);
  const [phase, setPhase] = useState(initial.phase);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(initial.prefs);
  const [recorder, setRecorder] = useState(initial.recorder);
  const [journal, setJournal] = useState(initial.journal);
  const [now, setNow] = useState(() => Date.now());
  const [relay, setRelay] = useState<Listed[]>([]);
  const rules = initial.rules;

  const refresh = useCallback(async (force: boolean) => {
    try {
      const [nextUniverse, nextIndices, nextRelay] = await Promise.all([
        getUniverse({ data: { refresh: force } }),
        getIndices(),
        getRelay().catch(() => [] as Listed[]),
      ]);
      setUniverse(nextUniverse);
      setIndices(nextIndices);
      setRelay(nextRelay);
      setRecorder(await getRecorder());
      setJournal((await getServerJournal()).days);
      setError(nextUniverse.stale ? "行情源不稳定，先显示上一轮数据" : null);
      setPhase(sessionPhase());
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPhase(sessionPhase());
      setNow(Date.now());
    }, 30_000);
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
    <Frame
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">{phase.label}</span>
          <span className="tabular-nums">{indexTime ? indexTime : formatClock(universe?.asOf ?? Date.now())}</span>
          <RecordLine at={recorder.at} ok={recorder.ok} now={now} />
        </div>
      }
      onRefresh={() => refresh(true)}
      extra={
        indices.length > 0 ? (
          <div className="flex gap-4 overflow-x-auto scroll-slim pb-2">
            {indices.map((item) => (
              <div key={item.id} className="flex shrink-0 items-baseline gap-1.5 text-xs">
                <span className="text-muted">{INDEX_LABEL[item.id] ?? item.name}</span>
                <span className={cx("tabular-nums", toneClass(item.pct))}>{signedPct(item.pct)}</span>
              </div>
            ))}
          </div>
        ) : null
      }
    >
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
          serverDays={journal}
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
      {selected ? (
        <Detail
          quote={selected}
          score={selectedRow?.score ?? null}
          reasons={selectedRow?.reasons ?? []}
          idle={!live}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </Frame>
  );
}
