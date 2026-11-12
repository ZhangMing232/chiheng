/**
 * 盯盘「今日梯队」（/watch/）——2026-11-12 按用户要求改成 **实时 + 可回看**。
 *
 * 为什么改：原来只读 data/signals/limit-pools-today.json，而那份文件一天只在收盘
 * 15:12 写一次。今天上午打开，看到的是昨天的收盘定格——用户原话「不是今天看昨天的」。
 * 现在：
 *   - 盘中由 home-server 每 3 分钟采一次三池，只刷新这份快取（sealed=false）；
 *   - 页面每 30 秒重读一次文件（**零外部请求**），页头显示采集时刻与「盘中未定」；
 *   - 日期下拉选历史交易日 → 读 data/history/limit-pools/<date>.json 的收盘归档；
 *   - 归档没有那天 → **不显示空梯队**，给「补拉这天」按钮，用户点了才去东财现拉
 *     （3 池串行 ~4 秒）。接口也没返回就明说「查不到」，不拿空名单冒充「那天没涨停」。
 *
 * 关于位置记忆：格子按「板位降序 → 同板位封单降序 → 代码升序」排，**规则固定**。
 * 但盘中数据是活的：新封的票会按同一规则插进来，封单额变了同档内的先后也会变。
 * 页面文案照实说，不再写「整天不重排」——那是收盘定格才成立的话。
 *
 * 数据：三池快照（东财 push2ex，盘中 3 分钟/收盘 15:12）
 *     + data/history/limit-up-reasons/<date>.json（涨停原因，收盘后采）
 * 原因文件和快照日期可能不同天，气泡里分别标，绝不拿别的日子的原因冒充。
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, WATCH_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import {
  backfillWatchDay,
  getMarketSnapshot,
  getWatchDay,
  getWatchDays,
  type WatchDay,
} from "@/lib/market/limit-up.functions";
import { getLimitUpReasons, getLimitUpReasonsForDay, type LimitUpReason } from "@/lib/market/quotes.functions";
import type { LimitUpRow } from "@/lib/market/limit-up";
import { usePageVisible, useVisibleInterval } from "@/lib/ui/use-visible-interval";
import { shanghaiDate } from "@/lib/market/session";

export const Route = createFileRoute("/watch/")({
  loader: async () => {
    const [snap, reasons, days] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {} as Record<string, LimitUpReason>, sectors: {} })),
      getWatchDays().catch(() => ({ archived: [] as string[], candidates: [] as string[] })),
    ]);
    return { snap, reasons, days, serverToday: shanghaiDate() };
  },
  component: WatchTodayPage,
});

/** 20261111 → 2026-11-11。第三方存的日期是 8 位数字，直接显示没人看得懂。 */
const ymd = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

const yi = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : `${(n / 1e4).toFixed(0)}万`);

/** 固定排序：板位降序 → 封单降序 → 代码升序。**规则不随时间变，但盘中会有新票插进来。** */
function fixedOrder(rows: LimitUpRow[]): LimitUpRow[] {
  return [...rows].sort((a, b) => {
    const sa = a.streak ?? 1;
    const sb = b.streak ?? 1;
    if (sb !== sa) return sb - sa;
    const fa = a.sealFund ?? 0;
    const fb = b.sealFund ?? 0;
    if (fb !== fa) return fb - fa;
    return (a.code ?? "").localeCompare(b.code ?? "");
  });
}

type Card = { row: LimitUpRow; broken: boolean };
type Reasons = { date: string; reasons: Record<string, LimitUpReason>; sectors: Record<string, { title: string; reason: string; date: string }[]> };

function WatchTodayPage() {
  const { snap, reasons, days, serverToday } = Route.useLoaderData();
  // "" = 今天实时；其余 = 回看某个历史交易日的收盘归档
  const [date, setDate] = useState("");
  const [pick, setPick] = useState<{ card: Card; x: number; y: number } | null>(null);
  const [backfill, setBackfill] = useState<WatchDay | null>(null);
  // mounted 仅客户端挂载后为 true。盘前/盘中快照每 3 分钟被 home-server 重写一份，
  // 若查询在「水合首帧」就跑（enabled 只拦了服务端、没拦客户端首帧），会拉到比 SSR
  // 更新的一份快取 → 页头 capturedAt 文本和水合文本对不上（#418 那类水合不一致）。
  // 所以实时查询必须等到挂载后再开，首帧（水合）一律用 loader 下发的 initialData。
  const [mounted, setMounted] = useState(false);
  const daysQ = useQuery({
    queryKey: ["watch", "days"],
    queryFn: () => getWatchDays(),
    initialData: days,
    // 挂载前不跑：首帧（水合）用 loader 下发的 initialData，避免拉到更新的一份导致脱节。
    enabled: mounted,
  });
  const [backfilling, setBackfilling] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const visible = usePageVisible();

  // 当前时刻只能在挂载后取（SSR 里读 Date.now() 会造成 #418 水合不一致）。
  useEffect(() => setNow(Date.now()), []);
  useEffect(() => setMounted(true), []);
  useVisibleInterval(() => setNow(Date.now()), 10_000);

  // 今天：每 30 秒重读一次本地快取。只读文件，不打东财；页面切到后台就停。
  const todayQ = useQuery({
    queryKey: ["watch", "today"],
    queryFn: () => getMarketSnapshot(),
    initialData: snap,
    refetchInterval: visible && date === "" ? 30_000 : false,
    enabled: mounted,
  });
  // 回看：只读归档，不联网。
  const dayQ = useQuery({
    queryKey: ["watch", "day", date],
    queryFn: () => getWatchDay({ data: { date } }),
    enabled: date !== "",
  });
  const reasonsQ = useQuery({
    queryKey: ["watch", "reasons", date],
    queryFn: () => (date ? getLimitUpReasonsForDay({ data: { date } }) : getLimitUpReasons()),
    ...(date === "" ? { initialData: reasons as Reasons } : {}),
    enabled: mounted,
  });

  // 气泡在滚走 / 切后台 / 按 Esc / 切日期时关掉，别留固定定位的浮层挂在屏幕上
  useEffect(() => {
    if (!pick) return;
    const close = () => setPick(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [pick]);
  useEffect(() => {
    if (!visible || date || backfill) setPick(null);
  }, [visible, date, backfill]);

  const isToday = date === "";
  // 水合首帧（mounted=false）必须用 loader 下发的 snap，不能用 todayQ.data——
  // 后者在客户端 hydration 期间已经被 createServerFn 实时拉到更新的一份快取，
  // 和 SSR 渲染用的 snap 不是同一时刻，capturedAt（页头时间）会差几分钟 → #418 水合不一致。
  // 挂载后 todayQ 才会去实时刷新，那时再切到 live 数据，已不在水合窗口内。
  const snapshot = isToday
    ? (mounted ? todayQ.data?.snapshot ?? null : snap.snapshot ?? null)
    : (dayQ.data?.snapshot ?? backfill?.snapshot ?? null);
  // 补拉失败的具体原因只放在按钮下面那行红字里，这里别再复述一遍（会同一句显示两次）。
  // 服务端盘中采集没跑（比如 serve 还没重启）时，快取文件可能还是前一天的。
  // 这时绝不能装作实时——直接把「这是哪天的数据」摆出来，让人知道要去重启。
  const staleDay = isToday && snapshot && snapshot.date !== serverToday;

  const why = snapshot
    ? null
    : isToday
      ? (mounted ? todayQ.data?.why ?? "快照还没采到" : snap.why ?? "快照还没采到")
      : (dayQ.data?.why ?? (dayQ.isLoading ? "正在读这一天的归档…" : "这天没有归档"));

  async function doBackfill() {
    setBackfilling(true);
    try {
      setBackfill(await backfillWatchDay({ data: { date } }));
      void dayQ.refetch();
      void daysQ.refetch();
    } finally {
      setBackfilling(false);
    }
  }

  const up = snapshot ? fixedOrder(snapshot.limitUp) : [];
  const broken = snapshot ? fixedOrder(snapshot.broken) : [];
  const captured = snapshot ? new Date(snapshot.capturedAt) : null;
  // capturedAt 是 epoch 毫秒，按 UTC 解析。这里统一加 8h 用 toISOString 取北京时间，
  // 不能用 toTimeString()——它读运行时本地时区，node 服务端(UTC)和浏览器(北京)会差 8 小时，
  // 导致 SSR 文本与水合文本对不上（#418 那类水合不一致）。
  const at = captured ? new Date(captured.getTime() + 8 * 3600_000).toISOString().slice(11, 19) : null;
  const ageText = captured && now
    ? ` · ${Math.max(0, Math.floor((now - snapshot!.capturedAt) / 1000))} 秒前`
    : "";

  const tiers: { key: string; streak: number | null; rows: LimitUpRow[]; broken: boolean }[] = [];
  for (const row of up) {
    const s = row.streak ?? 1;
    const last = tiers[tiers.length - 1];
    if (last && !last.broken && last.streak === s) last.rows.push(row);
    else tiers.push({ key: `s${s}`, streak: s, rows: [row], broken: false });
  }
  if (broken.length) tiers.push({ key: "broken", streak: null, rows: broken, broken: true });

  return (
    <Frame
      wide
      aside={
        /* 顶栏放真实状态，不重复页名 */
        <span className="num text-xs text-muted">
          {isToday
            ? `${snapshot?.date ?? "—"} ${snapshot?.sealed ? "收盘定格" : "盘中·未定"} ${at ?? "—"}${ageText}`
            : `${date} 收盘归档 · 封住 ${up.length} · 炸板 ${broken.length}`}
        </span>
      }
    >
      <SectionTabs ariaLabel="盯盘" tabs={WATCH_TABS} />

      {/* 像素终端标题块：盯盘是第二大页，给它和 /today 同一套语言 */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="px-slash">WATCH // LADDER</span>
        <span className="h-px flex-1 bg-line" />
        <span className="px-num text-[12px] text-muted">
          {isToday ? "盘中每 3 分钟采一次 · 收盘定格才算数" : `${date} 收盘归档 · 不会再变`}
        </span>
      </div>
      <div className="px-hazard mt-2" aria-hidden="true" />

      {/* 日期条：今天实时 / 选历史交易日回看。days 来自归档目录，不是写死的清单。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-line bg-surface px-3 py-2 text-xs">
        <label htmlFor="watch-date" className="text-muted">看哪天</label>
        <select
          id="watch-date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setBackfill(null);
            setPick(null);
          }}
          className="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-fg"
        >
          <option value="">今天（实时）</option>
          {daysQ.data.candidates.map((d) => (
            <option key={d} value={d}>
              {d}{daysQ.data.archived.includes(d) ? "（已归档）" : "（未归档·可补拉）"}
            </option>
          ))}
        </select>
        {isToday ? (
          <span className="text-muted">
            盘中每 3 分钟采一次三池，页面每 30 秒自动刷新（页面切到后台就停）。
            现在这份是<b className="text-fg">{snapshot?.sealed ? "收盘定格" : "盘中未定"}</b>，不是昨天的收盘数。
          </span>
        ) : (
          <span className="text-muted">
            回看的是<b className="text-fg">那天收盘后落的归档</b>，不会再变。
            <button type="button" onClick={() => { setDate(""); setBackfill(null); }} className="ml-2 text-brand hover:underline">
              回到今天实时 →
            </button>
          </span>
        )}
      </div>

      {staleDay && snapshot ? (
        <div className="rounded border border-warn bg-surface-2 px-3 py-2 text-xs leading-relaxed text-warn">
          这份快取是 <b className="num">{snapshot.date}</b> 的，不是今天（{serverToday}）。
          盘中采集没在跑——<b>重启一下 serve</b>（`npm run serve`）让每 3 分钟的心跳接上；
          在那之前这里显示的不是今天的盘面，别拿它盯盘。
        </div>
      ) : null}

      {!snapshot ? (
        <Panel title="封板梯队">
          <StateBlock kind="empty" title={isToday ? "今天还没有三池快照" : `${date} 没有归档`} hint={why ?? ""} />
          {!isToday ? (
            <div className="border-t border-line px-3 py-2 text-xs">
              <p className="mb-2 text-muted">
                归档没有 ≠ 那天没涨停。东财三池接口支持按日期查，大约保留最近三周；
                点一下现拉（3 个池串行，约 4 秒），拉到就补进归档，下次直接读本地。
              </p>
              <button
                type="button"
                disabled={backfilling}
                onClick={() => void doBackfill()}
                className="rounded border border-brand px-3 py-1 text-xs text-brand hover:bg-surface-2 disabled:opacity-50"
              >
                {backfilling ? "正在现拉…" : `补拉 ${date} 的三池`}
              </button>
              {backfill?.why && !backfill.snapshot ? (
                <p className="mt-2 text-up">{backfill.why}</p>
              ) : null}
            </div>
          ) : null}
        </Panel>
      ) : (
        <div className="px-noise flex flex-col gap-3">
          <Panel
            title="封板梯队"
            note={
              <span className="flex items-center gap-2">
                <span className={"h-1.5 w-1.5 rounded-full " + (isToday && !snapshot.sealed ? "bg-up live-dot" : "bg-muted")} aria-hidden />
                {isToday
                  ? `${snapshot.date} ${snapshot.sealed ? "收盘定格" : "盘中·未定"} ${at ?? ""}`
                  : `${snapshot.date} 收盘定格`}
              </span>
            }
          >
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3 py-2 text-xs text-muted">
              <span>封住 <b className="px-num px-chroma text-[16px] text-up">{up.length}</b></span>
              <span>炸板 <b className="px-num px-chroma text-[16px] text-muted">{broken.length}</b></span>
              {isToday ? (
                <span className="text-[12px]">
                  采集于 <b className="num text-fg">{at}</b>{ageText} · {snapshot.sealed ? "已收盘定格" : "盘中数据未定，收盘前还会变"}
                </span>
              ) : (
                <span className="text-[12px]">
                  这是 {snapshot.date} 的定盘快照，按日回补于 {at ?? "未知时刻"}；数据是那天收盘后的，不是补档当天。
                </span>
              )}
            </div>
            <div className="border-t border-line">
              {tiers.map((tier) => (
                <div key={tier.key} className="flex gap-2 border-b border-line px-2 py-2 last:border-b-0">
                  <div className="w-16 shrink-0 pt-0.5">
                    <div className={"px-num text-2xl font-bold leading-none " + (tier.broken ? "text-muted" : "text-brand")}>
                      {tier.broken ? "×" : tier.streak}
                    </div>
                    <div className="px-num mt-0.5 text-[12px] text-muted">{tier.broken ? "炸板" : "板"}</div>
                    <div className="mt-1 h-1.5 w-full bg-line">
                      <span className="block h-full bg-brand" style={{ width: `${Math.min(100, tier.rows.length * 8)}%` }} />
                    </div>
                    <div className="px-num mt-0.5 text-[12px] text-muted">{tier.rows.length} 只</div>
                  </div>
                  <div className="grid flex-1 grid-cols-2 content-start gap-1.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                    {tier.rows.map((r, i) => {
                      const streak = r.streak ?? 1;
                      return (
                        <button
                          key={`${r.id}-${i}`}
                          type="button"
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setPick({ card: { row: r, broken: tier.broken }, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
                          }}
                          className={
                            "flex flex-col gap-0.5 border px-2 py-1.5 text-left transition-colors " +
                            (tier.broken
                              ? "border-dashed border-line bg-surface-2 text-muted hover:border-muted"
                              : "border-up/40 bg-surface hover:bg-up-soft")
                          }
                          title={`${r.name} ${streak}板${tier.broken ? "（已炸板）" : ""}`}
                        >
                          <span className="flex items-baseline justify-between gap-1">
                            <span className="truncate text-xs font-medium">{r.name}</span>
                            <span className={"num shrink-0 text-[12px] " + (tier.broken ? "text-muted" : "text-up")}>
                              {r.sealFund != null ? yi(r.sealFund) : "—"}
                            </span>
                          </span>
                          <span className="num truncate text-[12px] text-muted">
                            {r.breaks ? `开 ${r.breaks} 次` : tier.broken ? "已炸板" : "未开板"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {tiers.length === 0 ? <div className="px-2 py-6 text-sm text-muted">这份快照里三池都是空的。</div> : null}
            </div>
            <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
              红实框=封住，灰虚框=炸板。点格子看涨停原因（带出处）。上面那个数是<b className="text-fg">封单金额</b>；
              「开 N 次」= 当天涨停被打开 N 次。
              {broken.length ? " 炸板票没有封单可算，所以显示 —。" : ""}
              {snapshot.bad > 0 ? ` 采集时有 ${snapshot.bad} 行解析失败，已跳过。` : ""}
              {" "}排序规则固定（板位降序 → 同板位封单降序 → 代码升序），
              {isToday ? "盘中新封的票会按同一规则插进来，封单额变了同档先后也会变——不会按时间或涨跌乱跳。" : "归档不会再变。"}
              {reasonsQ.data && !reasonsQ.data.date && !isToday ? " 这天没采到涨停原因原文，气泡里会如实写。" : ""}
            </div>
          </Panel>
        </div>
      )}

      <div className="px-ticks-x" aria-hidden="true" />
      <div className="px-barcode" aria-hidden="true" />

      {/* 手机端固定结论条：封住/炸板一屏看完，不用往上滚 */}
      <div className="px-mobile-bar sm:hidden">
        <div className="px-num text-[12px] text-muted">
          封住 <b className="text-up">{up.length}</b> · 炸板 <b className="text-fg">{broken.length}</b>
          {isToday ? <span className="ml-2 text-brand">{snapshot?.sealed ? "收盘定格" : "盘中未定"}</span> : null}
        </div>
        <div className="px-num text-[12px] text-brand">看梯队 ▾</div>
      </div>

      {pick ? (
        <ReasonPopover
          pick={pick}
          reasons={(reasonsQ.data as Reasons | undefined) ?? (reasons as Reasons)}
          onClose={() => setPick(null)}
        />
      ) : null}
    </Frame>
  );
}

/**
 * 涨停原因气泡。位置由点击时的格子坐标算出来，夹在视口内，别跑出屏幕。
 * 出处三行分开写：原记录日期 / 来源 / 题材催化日期——混成一行就分不清谁是谁。
 * 回看模式下若那天没有原因文件，date 是空的，这里必须说「没采到」，不能拿别的日子凑。
 */
function ReasonPopover({
  pick,
  reasons,
  onClose,
}: {
  pick: { card: Card; x: number; y: number };
  reasons: Reasons;
  onClose: () => void;
}) {
  const r = pick.card.row;
  const info = reasons.reasons[r.code ?? ""];
  const sector = info?.primary_concept ? reasons.sectors[info.primary_concept]?.[0] : undefined;
  const W = 380;
  const left = typeof window === "undefined" ? pick.x : Math.min(Math.max(12, pick.x - W / 2), window.innerWidth - W - 12);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        className="sheet-in fixed z-50 rounded-lg border border-line bg-surface p-3 shadow-pop"
        style={{ left, top: pick.y, width: W, maxHeight: "60vh", overflowY: "auto" }}
        role="dialog"
        aria-label={`${r.name} 涨停原因`}
      >
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{r.name}</span>
          <span className="num text-[12px] text-muted">
            {r.code} · {(r.streak ?? 1)}板
            {pick.card.broken ? " · 已炸板" : ""}
          </span>
        </div>

        {!reasons.date ? (
          <div className="text-[12px] leading-relaxed text-muted">
            这一天没采到涨停原因原文（原因文件按日落盘，不是每只票都有）。
            <div className="mt-1 text-[12px]">这里留空，不拿别的日子的理由凑。</div>
          </div>
        ) : info ? (
          <>
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {info.primary_concept ? <Tag tone="muted">{info.primary_concept}</Tag> : null}
              {info.theme ? <span className="text-[12px] text-muted">{info.theme}</span> : null}
            </div>
            <div className="text-[12px] leading-relaxed whitespace-pre-line">
              {info.reason.length > 320 ? `${info.reason.slice(0, 320)}…` : info.reason}
            </div>
            <div className="mt-2 rounded border border-line bg-surface-2 px-2 py-1.5 text-[12px] leading-relaxed text-muted">
              <div>
                <b className="text-fg">原记录</b> {ymd(reasons.date)}
                <span className="float-right">{info.source || "来源未标"}</span>
              </div>
              {sector ? (
                <div className="mt-1 border-t border-line pt-1">
                  <b className="text-fg">题材催化</b> {ymd(sector.date)} · {sector.title.slice(0, 60)}
                  {sector.title.length > 60 ? "…" : ""}
                </div>
              ) : (
                <div className="mt-1 border-t border-line pt-1">该题材这天没有采到催化原文（不是「没有消息」）。</div>
              )}
            </div>
          </>
        ) : (
          <div className="text-[12px] leading-relaxed text-muted">
            这只票这天没采到涨停原因原文——原因来自盘后第三方整理，不是每只票都有。
            <div className="mt-1 text-[12px]">原记录 {ymd(reasons.date)}。这里留空，不编一条理由。</div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded border border-line py-1 text-[12px] text-muted hover:bg-surface-2"
        >
          关闭（Esc）
        </button>
      </div>
    </>
  );
}
