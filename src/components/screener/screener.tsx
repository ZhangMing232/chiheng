/**
 * 这个文件是干什么的：
 * 选股页整页。顶上是交易时段、指数涨跌和上次记账时间，下面是筛选、精选和股票池。
 * 点一只股票打开详情，点刷新再拉一轮行情。
 *
 * 你需要知道的：
 * 名单在这里算出来。买入卖出由服务端记账进程写（data/books，见 record-journal.ts），
 * 这里只读不写——2026-10-25 两本账对齐后，浏览器那本（Journal 组件，已停写）退役，
 * 本页原有的 <Journal> 挂载摘除。本地账与服务端账的合并在策略追踪页手动触发。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Picks } from "@/components/screener/picks";
import { PrefsBar, BOARDS, PRICES, CAPS } from "@/components/screener/prefs-bar";
import { FilterChip } from "@/components/filter-chip";
import { Frame } from "@/components/screener/nav";
import { cycleTheme } from "@/components/screener/nav";
import { SectionTabs } from "@/components/section-tabs";
import { STRATEGY_TABS } from "@/lib/ui/strategy-tabs";
import { runningStyles, type GateLike } from "@/lib/ui/running-styles";
import { useHotkeys } from "@/lib/ui/hotkeys";
import { useSymbolUi } from "@/lib/ui/symbol-store";
import { cycleStyle, watchList, ACTIVE_STYLES, STYLES, styleOf, type Listed, type StyleId } from "@/lib/market/strategies";
import { CollapsibleSection } from "@/components/collapsible";
import { matchPrefs, type Prefs } from "@/lib/market/prefs";
import { getIndices, getRecorder, getRelay, getServerJournal, getStrategyGates, getUniverse, savePrefs } from "@/lib/market/quotes.functions";
import { AccountStatus, DataStatusBadge } from "@/components/screener/data-status";
import { Panel, Tape, Tag } from "@/components/terminal";
import { HeroStat } from "@/components/hero-stat";
import { Clock, Database, Gauge, Cpu } from "lucide-react";
import { StateBlock } from "@/components/state-block";
import { formatClock, sessionPhase } from "@/lib/market/session";
import type { IndexQuote, SessionInfo, Universe } from "@/lib/market/types";
import type { PaperDay } from "@/lib/paper";
import type { EarlyRules } from "@/lib/market/rules";

function RecordLine({ at, ok, now }: { at: number | null; ok: boolean; now: number | null }) {
  if (at == null) return <span>还没有记账</span>;
  // now 为 null（SSR/hydration 阶段）时按"未过期"处理——挂载后才会拿到真实时刻再判断，
  // 这样首屏两边渲染一致，不会触发 #418。
  const stale = now != null && now - at > 3 * 60_000;
  const clock = formatClock(at);
  if (!ok) return <span className="text-up">记账失败 {clock}</span>;
  if (stale) return <span className="text-up">记账中断 {clock}</span>;
  return <span className="tabular-nums">上次记账 {clock}</span>;
}

// 选股页「已激活筛选」可视化：把 board/price/cap 里不是 all 的维度渲染成可移除芯片。
// 纯展示 + 复位，不动底层 matchPrefs 过滤逻辑（#114）。
const PREF_GROUPS: { dim: "board" | "price" | "cap"; name: string; options: { id: string; label: string }[] }[] = [
  { dim: "board", name: "板块", options: BOARDS },
  { dim: "price", name: "股价", options: PRICES },
  { dim: "cap", name: "市值", options: CAPS },
];

function activePrefChips(prefs: Prefs) {
  return PREF_GROUPS.flatMap((g) => {
    const opt = g.options.find((o) => o.id === prefs[g.dim]);
    if (!opt || prefs[g.dim] === "all") return [];
    return [{ dim: g.dim, name: g.name, label: opt.label }];
  });
}

function resetPrefDim(prefs: Prefs, dim: "board" | "price" | "cap"): Prefs {
  if (dim === "board") return { ...prefs, board: "all" };
  if (dim === "price") return { ...prefs, price: "all" };
  return { ...prefs, cap: "all" };
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
  /** 策略闸状态随首屏一起下发，不然 SSR 会先把被停用的策略画出来、客户端拉到闸门再抽掉，闪一下。 */
  gates: Record<string, GateLike>;
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
  // personal/why 跟 journal 是一套的：refresh 每分钟都会重读服务端账，
  // 只换 days 不换这两个，会话过期后页面会拿着旧 personal=true 显示空账，
  // 看起来像「今天没开仓」——所以提升成 state 一起更新。
  const [personal, setPersonal] = useState(initial.personal);
  const [journalWhy, setJournalWhy] = useState(initial.journalWhy);
  // 当前时刻只用于「X 分钟前」这类相对时间展示。不能在 useState 初始化里调 Date.now()
  // （SSR 与 hydration 会各取一个时刻 → #418）。先置 null，挂载后再填真实值，
  // 并每 30s 刷新一次。
  const [now, setNow] = useState<number | null>(null);
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
      const nextJournal = await getServerJournal();
      setJournal(nextJournal.days);
      setPersonal(nextJournal.personal);
      setJournalWhy(nextJournal.why);
      setError(nextUniverse.stale ? "行情源不稳定，先显示上一轮数据" : null);
      setPhase(sessionPhase());
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    }
  }, []);

  // universe 刻意不走 SSR（全量 ~1.2MB 会把手机端卡死，见 routes/strategies/screener.tsx），
  // 挂载后客户端拉：外壳先出来，名单到了再填。
  useEffect(() => {
    if (initial.universe == null) void refresh(false);
  }, [initial.universe, refresh]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setPhase(sessionPhase());
      setNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const pull = () => void getRelay().then(setRelay).catch(() => undefined);
    pull();
    // 页面在后台不轮询：接力榜没人看的时候不该占接口（参考连板网的 visibilitychange 做法）。
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      pull();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!phase.open) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh(false);
    }, 60_000);
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
    // ← → / 1-6 切策略。**这两个键在 HOTKEYS 键位表里一直承诺着，但之前没有任何
    // 页面注册**——面板上说有、按下没反应，是最难查的一类不一致
    // （hotkeys.tsx 文件头第 1 条就是为了防这个）。
    // 只在 ACTIVE_STYLES 里循环：trend/early 已经不自动建仓，切过去只会看到空榜。
    // pickStyle 定义在下面（const 晚于本调用）——箭头函数延迟到按键时才求值，安全。
    onCycleStyle: (dir) => {
      const next = cycleStyle(ACTIVE_STYLES as readonly string[], prefs.style, dir);
      if (next) pickStyle(next as Prefs["style"]);
    },
    onPickStyle: (n) => {
      const next = (ACTIVE_STYLES as readonly string[])[n - 1];
      if (next) pickStyle(next as Prefs["style"]);
    },
  });

  const quotes = universe?.quotes ?? [];
  const ranked = useMemo(() => {
    if (prefs.style === "relay") return relay.filter((row) => matchPrefs(row.quote, prefs));
    return watchList(quotes, prefs.style, rules, (quote) => matchPrefs(quote, prefs));
  }, [quotes, rules, prefs, relay]);

  const indexTime = indices.find((item) => item.time)?.time;
  // 策略闸状态（记账进程判决、落盘）：首屏用 loader 下发的那份，之后每分钟刷新。
  // 「现役策略」条只列没被停用的；左侧筛选列表仍给停用的挂标记，方便切过去看历史。
  const { data: gateData } = useQuery({
    queryKey: ["strategy-gates"],
    queryFn: () => getStrategyGates(),
    initialData: { gates: initial.gates },
    refetchInterval: 60_000,
  });
  const gates = gateData?.gates ?? {};
  const running = runningStyles(ACTIVE_STYLES, gates);
  // 左侧面板要标每个策略今天建仓了几只（和 Picks 里页签数字同一口径）。
  const styleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const trade of journal.filter((day) => day.date === phase.date).flatMap((day) => day.trades)) {
      const style = styleOf(trade);
      if (style) counts[style] = (counts[style] ?? 0) + 1;
    }
    return counts;
  }, [journal, phase.date]);

  const gatesOff = Object.values(gates).filter((g) => g.state === "disabled").length;

  // 左侧策略列表和 Picks 内部（窄屏兜底页签）共用同一个切换逻辑：改本地状态并落盘。
  const pickStyle = (style: Prefs["style"]) => {
    const next = { ...prefs, style };
    setPrefs(next);
    void savePrefs({ data: next }).catch(() => setError("偏好没保存上，刷新后会回到上次的选择"));
  };

  // 顶部「现役策略」条：每套现役策略今天的候选数（同一套筛选口径，和切过去看到的数字一致）。
  const candidateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of ACTIVE_STYLES) {
      counts[id] = watchList(quotes, id, rules, (quote) => matchPrefs(quote, prefs)).length;
    }
    return counts;
  }, [quotes, rules, prefs]);

  return (
    <Frame
      wide
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">{phase.label}</span>
          <span className="tabular-nums">{indexTime ? indexTime : formatClock(universe?.asOf ?? null)}</span>
          <AccountStatus personal={personal} why={journalWhy} />
          <DataStatusBadge universe={universe} onRefresh={() => void refresh(true)} />
          <RecordLine at={recorder.at} ok={recorder.ok} now={now} />
        </div>
      }
      onRefresh={() => refresh(true)}
      ornamentContent={
        // **真实数据**：quotes 是当前池子里的票（universe?.quotes）。
        // 池子是全市场快照，不是「选出来的候选」——所以文案写「在池」不写「候选」，
        // 后者会让人以为已经筛过一遍。
        quotes.length > 0 ? (
          <span className="text-[12px] tabular-nums">在池 {quotes.length} 只</span>
        ) : (
          <span className="text-[12px]">池子还没拉到</span>
        )
      }
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
        {/* 2026-10-21 整合：选股和追踪同属「策略」区（/strategies 下两个子页面），
            顶部给二级 tab，和追踪页是同一组。 */}
        <SectionTabs
          ariaLabel="策略"
          tabs={STRATEGY_TABS}
        />
        {/* 状态卡行（效果图签名件）：结果快照 / 行情延迟 / 策略引擎 / 风控闸门，全真实 */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <HeroStat
            icon={<Database size={18} />}
            label="结果快照"
            value={universe?.asOf ? new Date(universe.asOf).toTimeString().slice(0, 5) : "—"}
            tone={universe ? (universe.stale ? "warn" : "ok") : "muted"}
            sub={universe ? `上次生成 ${universe.stale ? "已过期，别当现价用" : "选股按这份快照"}` : "快照暂未拉到"}
          />
          <HeroStat
            icon={<Clock size={18} />}
            label="行情延迟"
            value={universe?.asOf && now != null ? `${Math.max(0, Math.round((now - universe.asOf) / 60_000))} 分钟` : "—"}
            tone={universe?.asOf && now != null && now - universe.asOf < 120_000 ? "ok" : "warn"}
            sub="腾讯 LV1 · 非实时"
          />
          <HeroStat
            icon={<Cpu size={18} />}
            label="策略引擎"
            value={recorder.at != null && now != null && now - recorder.at < 5 * 60_000 ? "正常" : recorder.at == null ? "还没记" : "停了"}
            tone={recorder.at != null && now != null && now - recorder.at < 5 * 60_000 ? "ok" : "warn"}
            sub={recorder.at ? `上次记账 ${new Date(recorder.at).toTimeString().slice(0, 5)} · 每分钟跑` : "还没记过账"}
          />
          <HeroStat
            icon={<Gauge size={18} />}
            label="风控闸门"
            value={gatesOff === 0 ? "正常" : `${gatesOff} 套停用`}
            tone={gatesOff === 0 ? "ok" : "warn"}
            sub={gatesOff === 0 ? "全部策略按预登记规则交易" : "停用名单见左侧策略列表"}
          />
        </div>
        {/* 现役策略条（2026-11-05 换掉原「策略实验台」）。
            这块只回答一件事：今天哪几套真正在跑、各自挑了几只。
            被策略闸停用的、已下线的都不上来（用户 2026-11-05 点名，和 10-21
            「筛选条件里不该出现已下线策略」是同一条规矩）——停用原因和冷却进度
            去「策略管理」页看，不在选股页开头占位置。全被停了要明说，不许留空白。 */}
        <Panel
          title="现役策略"
          note="只列今天真正在跑的；被停用的去「策略管理」看原因"
          className="mb-2"
        >
          {running.length === 0 ? (
            <StateBlock
              compact
              kind="empty"
              title="今天没有现役策略在跑"
              hint="现役的几套都被策略闸停了。去「策略管理」看停用原因和冷却进度；已有持仓照常结算，不受影响。"
            />
          ) : (
            <div className="grid gap-px bg-line sm:grid-cols-2">
              {running.map((id) => {
                const gate = gates[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => pickStyle(id)}
                    aria-pressed={id === prefs.style}
                    className={
                      "px-3 py-2.5 text-left transition " +
                      (id === prefs.style ? "bg-brand-soft" : "bg-surface hover:bg-surface-2/60")
                    }
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`text-sm ${id === prefs.style ? "font-medium text-brand-text" : "font-medium text-fg"}`}>
                        {STYLES.find((item) => item.id === id)?.name ?? id}
                      </span>
                      <span className="flex items-baseline gap-2 text-xs text-muted">
                        <span className="tabular-nums">候选 {candidateCounts[id] ?? 0} · 持仓 {styleCounts[id] ?? 0}</span>
                        {gate ? (
                          <Tag tone="brand">假释中</Tag>
                        ) : (
                          <Tag tone="up">在跑</Tag>
                        )}
                      </span>
                    </div>
                    {/* 假释中仍在建仓，但为什么被盯着要写清，别让人以为它跟正常在跑一样。 */}
                    {gate ? (
                      <p className="mt-1 text-[12px] leading-relaxed text-muted">
                        {gate.since} 起 · {gate.reason}
                      </p>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </Panel>
        {error ? (
          <StateBlock
            kind="error"
            title="页面没能拿到最新数据"
            hint={`${error}。上面显示的是上一次拿到的数据，别拿它当现价用。`}
            action={{ label: "重新拉一次", onClick: () => void refresh(true) }}
          />
        ) : null}
        {/* PPT 03 版面：左侧 280px 放策略和筛选，右侧是精选结果。窄屏自动收成上下两截。 */}
        <div className="grid items-start gap-2 lg:grid-cols-[280px_1fr]">
          <Panel title="筛选条件" bodyClassName="flex flex-col gap-3">
            <div>
              <div className="text-[12px] tracking-widest text-muted">策略</div>
              <div className="mt-1 flex flex-col gap-0.5">
                {/* 只平铺今天真正在跑的（和上方「现役策略」同一份 running）。
                    被闸门停用的、已下线的都收进下面折叠区，不和能用的混在一起
                    （2026-10-21 用户点名不该出现已下线；2026-11-05 补上已停用）。
                    假释中仍在建仓，留在主列表并标注，不算停用。 */}
                {running.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted">
                    现役策略都被停用了，今天不建仓；下面可切过去查看历史。
                  </p>
                ) : (
                  STYLES.filter((item) => (running as string[]).includes(item.id)).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => pickStyle(item.id)}
                      aria-pressed={item.id === prefs.style}
                      className={
                        "flex items-center justify-between rounded px-2 py-1.5 text-sm text-left " +
                        (item.id === prefs.style
                          ? "bg-brand-soft font-medium text-brand-text"
                          : "text-muted hover:bg-surface-2 hover:text-fg")
                      }
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate">{item.name}</span>
                        {/* disabled 已被 running 过滤掉，这里只可能是 paroled。 */}
                        {gates[item.id] ? (
                          <span
                            title={gates[item.id].reason}
                            className="shrink-0 rounded bg-accent-soft px-1 text-[12px] text-accent"
                          >
                            假释中
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular-nums text-xs">{styleCounts[item.id] ?? 0}</span>
                    </button>
                  ))
                )}
              </div>
              {(() => {
                // 不在 running 里的都收这儿：已下线的、以及被闸门停用的现役策略。
                // 不删掉——还能切过去看历史候选，也能看清它为什么没在跑。
                const parked = STYLES.filter(
                  (item) => !(running as string[]).includes(item.id),
                );
                if (parked.length === 0) return null;
                return (
                  <CollapsibleSection
                    storageKey="ch-collapse-retired-styles"
                    // 选中的恰是停用/下线策略时默认展开，不然用户找不到当前选中项在哪。
                    defaultOpen={parked.some((item) => item.id === prefs.style)}
                    className="mt-1"
                    headerClassName="bg-surface-2"
                    header={
                      <>
                        <h3 className="text-xs font-medium">停用 / 已下线（{parked.length}）</h3>
                        <p className="text-[12px] text-muted">不参与建仓，只留查看；停用原因见「策略管理」</p>
                      </>
                    }
                  >
                    <div className="flex flex-col gap-0.5 px-1.5 py-1.5">
                      {parked.map((item) => {
                        const gate = gates[item.id];
                        const label = gate?.state === "disabled" ? "已停用" : "已下线";
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => pickStyle(item.id)}
                            aria-pressed={item.id === prefs.style}
                            title={gate?.reason ?? "已下线，不再自动建仓"}
                            className={
                              "flex items-center justify-between rounded px-2 py-1.5 text-sm text-left " +
                              (item.id === prefs.style
                                ? "bg-brand-soft font-medium text-brand-text"
                                : "text-muted hover:bg-surface-2 hover:text-fg")
                            }
                          >
                            <span className="flex min-w-0 items-center gap-1">
                              <span className="truncate">{item.name}</span>
                              <span className="shrink-0 rounded bg-warn-soft px-1 text-[12px] text-warn">{label}</span>
                            </span>
                            <span className="tabular-nums text-xs">{styleCounts[item.id] ?? 0}</span>
                          </button>
                        );
                      })}
                    </div>
                  </CollapsibleSection>
                );
              })()}
              <p className="mt-2 text-xs text-muted">{STYLES.find((item) => item.id === prefs.style)?.hint}</p>
            </div>
            {activePrefChips(prefs).length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] tracking-widest text-muted">已选</span>
                {activePrefChips(prefs).map((chip) => (
                  <FilterChip
                    key={chip.dim}
                    label={
                      <>
                        <span className="text-muted">{chip.name}</span> {chip.label}
                      </>
                    }
                    onRemove={() => {
                      const next = resetPrefDim(prefs, chip.dim);
                      setPrefs(next);
                      void savePrefs({ data: next }).catch(() => setError("偏好没保存上，刷新后会回到上次的选择"));
                    }}
                  />
                ))}
              </div>
            ) : null}
            <PrefsBar
              prefs={prefs}
              onChange={(next) => {
                setPrefs(next);
                void savePrefs({ data: next }).catch(() => setError("偏好没保存上，刷新后会回到上次的选择"));
              }}
            />
            {/* 设计稿里的主按钮：品牌色实底，点击等价于 F5（复用缓存重跑本页） */}
            <button
              type="button"
              onClick={() => void refresh(false)}
              className="mt-auto w-full rounded bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
            >
              ▶ 运行选股（F5）
            </button>
          </Panel>
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
            personal={personal}
            serverWhy={journalWhy}
            rules={rules}
            style={prefs.style}
            marketOpen={phase.open}
            tailHalf={phase.tailHalf}
            pause={phase.label}
            benchmark={null}
            hideTabs
            onStyle={pickStyle}
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
        </div>
    </Frame>
  );
}
