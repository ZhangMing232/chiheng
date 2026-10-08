/**
 * 这个文件是干什么的：
 * 选股页整页。顶上是交易时段、指数涨跌和上次记账时间，下面是筛选、精选和股票池。
 * 点一只股票打开详情，点刷新再拉一轮行情。
 *
 * 你需要知道的：
 * 名单在这里算出来。真正记买入卖出的是旁边那个不显示的记账组件。开盘时大约每分钟更新一次。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Journal } from "@/components/screener/paper";
import { LabPanel } from "@/components/screener/lab-panel";
import { Picks } from "@/components/screener/picks";
import { PrefsBar } from "@/components/screener/prefs-bar";
import { Frame } from "@/components/screener/nav";
import { cycleTheme } from "@/components/screener/nav";
import { useHotkeys } from "@/lib/ui/hotkeys";
import { useSymbolUi } from "@/lib/ui/symbol-store";
import { buildLabReport } from "@/lib/market/lab";
import { isIdleBook } from "@/lib/market/model";
import { watchList, type Listed } from "@/lib/market/strategies";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { getIndices, getRecorder, getRelay, getServerJournal, getUniverse, savePrefs } from "@/lib/market/quotes.functions";
import { AccountStatus, DataStatusBadge } from "@/components/screener/data-status";
import { Tape } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { formatClock, sessionPhase } from "@/lib/market/session";
import type { IndexQuote, SessionInfo, Universe } from "@/lib/market/types";
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

export const INDEX_LABEL: Record<string, string> = {
  sh510300: "沪深300ETF",
  sh000300: "沪深300",
  sh000001: "上证",
  sz399001: "深成",
  sz399006: "创业",
  sh000688: "科创",
};

export type ScreenerInitial = {
  universe: Universe | null;
  indices: IndexQuote[];
  journal: PaperDay[];
  personal: boolean;
  /** 服务端账本没读到时的原因。null 表示读到了。 */
  journalWhy: string | null;
  rules: EarlyRules;
  prefs: Prefs;
  recorder: { at: number | null; ok: boolean };
  error: string | null;
  phase: SessionInfo;
};

/** 选股页总装。负责拉行情、记住你点开的股票，并把筛选和名单交给下面几块。 */
export function Screener({ initial }: { initial: ScreenerInitial }) {
  const [universe, setUniverse] = useState(initial.universe);
  const [indices, setIndices] = useState(initial.indices);
  const [error, setError] = useState(initial.error);
  const [phase, setPhase] = useState(initial.phase);
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

  // 全局快捷键。F5 / r 只复用缓存重跑本页；⌥F5 才真去拉全市场——
  // 全量重拉 5200 只会把腾讯顶到 WAF（quotes.functions.ts:34-38），所以放在要按两次的键上。
  const router = useRouter();
  const openSymbol = useSymbolUi((s) => s.open);
  useHotkeys({
    onRefresh: () => {
      void refresh(false);
      void router.invalidate();
    },
    onForceRefresh: () => void refresh(true),
    onToggleTheme: cycleTheme,
  });

  const quotes = universe?.quotes ?? [];
  const live = !isIdleBook(quotes);
  const ranked = useMemo(() => {
    if (prefs.style === "relay") return relay.filter((row) => matchPrefs(row.quote, prefs));
    return watchList(quotes, prefs.style, rules, (quote) => matchPrefs(quote, prefs));
  }, [quotes, rules, prefs, relay]);

  const indexTime = indices.find((item) => item.time)?.time;
  const labReport = useMemo(() => buildLabReport(journal, rules), [journal, rules]);

  return (
    <Frame
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">{phase.label}</span>
          <span className="tabular-nums">{indexTime ? indexTime : formatClock(universe?.asOf ?? Date.now())}</span>
          <AccountStatus personal={initial.personal} why={initial.journalWhy} />
          <DataStatusBadge universe={universe} now={now} onRefresh={() => void refresh(true)} />
          <RecordLine at={recorder.at} ok={recorder.ok} now={now} />
        </div>
      }
      onRefresh={() => refresh(true)}
      extra={
        // 横条行情：财联社那种一眼扫完的排法。涨跌幅上色块而不是只上字色，
        // 余光扫过去就能分出红绿，不用逐个数字去读。
        indices.length > 0 ? (
          <Tape
            className="border-b border-line"
            items={indices.map((item) => ({
              id: item.id,
              name: INDEX_LABEL[item.id] ?? item.name,
              price: item.price > 0 ? item.price : null,
              pct: item.pct,
            }))}
          />
        ) : null
      }
    >
        <LabPanel report={labReport} />
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
        {error ? (
          <StateBlock
            kind="error"
            title="页面没能拿到最新数据"
            hint={`${error}。上面显示的是上一次拿到的数据，别拿它当现价用。`}
            action={{ label: "重新拉一次", onClick: () => void refresh(true) }}
          />
        ) : null}
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
          personal={initial.personal}
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
          onOpen={(id) => {
            // 抽屉改成全局的了（见 symbol-store）：这里不再持有 selectedId，
            // 只负责把「模型得分 + 入选理由」一并带过去——别的页面打开时没有这两个数，
            // 抽屉会显示「未参加当前模型」，不编分数。
            const row = ranked.find((item) => item.quote.id === id);
            openSymbol(id, "screener", {
              score: row?.score ?? null,
              reasons: row?.reasons ?? [],
            });
          }}
        />
    </Frame>
  );
}
