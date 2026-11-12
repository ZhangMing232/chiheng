/**
 * 今日梯队（/watch/）——原「多股同屏 /grid」，2026-11-11 晚并进盯盘区。
 *
 * 这一页只做一件事：**位置记忆**。格子按「板位降序、同板位按封单额降序」排好后
 * 就固定不动，红框=封住了、灰虚框=炸了。盘中去盯同一格，不要让它换位置。
 * 参考连板网 /grid.html 的那句说明：盯盘盘的是位置记忆，不是排序。
 *
 * 点格子 → 弹「涨停原因」气泡，气泡里必须带出处（原记录日期 + 来源 + 题材催化），
 * 出处比结论更显眼——这是这一版特意加的东西，别为了好看把来源那一行删了。
 *
 * 和 /watch/history（三日演变）的分工：那边看昨天/前天到今天怎么变、晋级率多少；
 * 这边只看今天、看位置。**两页不重复列同一批票的明细**——今天谁封了多少单，
 * 只有这一页有。
 *
 * 数据：data/signals/limit-pools-today.json（15:12 收盘快照）
 *     + data/history/limit-up-reasons/YYYY-MM-DD.json（涨停原因，收盘后采）
 * 两者日期可能不同天（原因文件是「最近一次采到的」），页面上分别标，不许合并成一个时间。
 */

import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, WATCH_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getMarketSnapshot } from "@/lib/market/limit-up.functions";
import { getLimitUpReasons, type LimitUpReason } from "@/lib/market/quotes.functions";
import type { LimitUpRow } from "@/lib/market/limit-up";
import { usePageVisible } from "@/lib/ui/use-visible-interval";

export const Route = createFileRoute("/watch/")({
  loader: async () => {
    const [snap, reasons] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {} as Record<string, LimitUpReason>, sectors: {} })),
    ]);
    return { snap, reasons };
  },
  component: WatchTodayPage,
});

/** 20261111 → 2026-11-11。第三方存的日期是 8 位数字，直接显示没人看得懂。 */
const ymd = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);

const yi = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : `${(n / 1e4).toFixed(0)}万`);

/** 固定排序：板位降序 → 封单降序 → 代码升序。**任何随数据变化的重排都是错的。** */
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

function WatchTodayPage() {
  const { snap, reasons } = Route.useLoaderData();
  const [pick, setPick] = useState<{ card: Card; x: number; y: number } | null>(null);
  const visible = usePageVisible();

  // 气泡在滚走 / 切后台 / 按 Esc 时关掉，别留一个固定定位的浮层挂在屏幕上
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
    if (!visible) setPick(null);
  }, [visible]);

  const snapshot = snap.snapshot;
  if (!snapshot) {
    return (
      <Frame wide aside={<span className="text-xs text-muted">今天还没有三池快照</span>}>
        <SectionTabs ariaLabel="盯盘" tabs={WATCH_TABS} />
        <Panel title="封板梯队">
          <StateBlock kind="empty" title="今天还没有三池快照" hint={snap.why ?? "收盘后 15:12 采集，之后再看。"} />
        </Panel>
      </Frame>
    );
  }

  const up = fixedOrder(snapshot.limitUp);
  const broken = fixedOrder(snapshot.broken);
  const at = new Date(snapshot.capturedAt).toTimeString().slice(0, 5);

  /**
   * 按板位分档，一档一行。排序仍然是固定的（板位降序 → 封单降序 → 代码升序），
   * 只是把「同板位」聚成一条横排——不然 4 板 3 板 2 板 1 板铺在一个大网格里，
   * 靠排序区分等于没区分，天梯的层级看不出来。炸板单独一档放最后，绝不混进封住里。
   */
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
        /* 顶栏这行放真实快照状态，不重复页名（页名在第一行页头里已经有了） */
        <span className="num text-xs text-muted">
          {snapshot.date} {snapshot.sealed ? "收盘定格" : "盘中·未定"} {at} · 封住 {up.length} · 炸板 {broken.length}
        </span>
      }
    >
      <SectionTabs ariaLabel="盯盘" tabs={WATCH_TABS} />
      <div className="flex flex-col gap-3">
        <Panel
          title="封板梯队"
          note={
            <span className="flex items-center gap-2">
              <span className={"h-1.5 w-1.5 rounded-full " + (snapshot.sealed ? "bg-muted" : "bg-up live-dot")} aria-hidden />
              {snapshot.date} {snapshot.sealed ? "收盘定格" : "盘中·未定"} {at}
            </span>
          }
        >
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3 py-2 text-xs text-muted">
            <span>
              封住 <b className="num text-up">{up.length}</b>
            </span>
            <span>
              炸板 <b className="num text-muted">{broken.length}</b>
            </span>
            <span className="text-[11px]">
              排序固定：板位降序 → 同板位封单降序。不看时间、不看涨跌、整天不重排——盯的是位置。
            </span>
          </div>
          <div className="border-t border-line">
            {tiers.map((tier) => (
              <div key={tier.key} className="flex gap-2 border-b border-line px-2 py-2 last:border-b-0">
                {/* 左边这列是「几板」，天梯的台阶刻度就靠它 */}
                <div className="w-11 shrink-0 pt-0.5 text-right">
                  <div className={"num text-sm font-semibold " + (tier.broken ? "text-muted" : "text-up")}>
                    {tier.broken ? "炸板" : `${tier.streak}板`}
                  </div>
                  <div className="num text-[10px] text-muted">{tier.rows.length} 只</div>
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
                          "flex flex-col gap-0.5 rounded border px-2 py-1.5 text-left transition-colors " +
                          (tier.broken
                            ? "border-dashed border-line bg-surface-2 text-muted hover:border-muted"
                            : "border-up/40 bg-surface hover:bg-up-soft")
                        }
                        title={`${r.name} ${streak}板${tier.broken ? "（已炸板）" : ""}`}
                      >
                        <span className="flex items-baseline justify-between gap-1">
                          <span className="truncate text-xs font-medium">{r.name}</span>
                          {/* 板位已经在左边那列标了，卡片里不再重复；这里放封单额，是同一档里比强弱的数 */}
                          <span className={"num shrink-0 text-[10px] " + (tier.broken ? "text-muted" : "text-up")}>
                            {r.sealFund != null ? yi(r.sealFund) : "—"}
                          </span>
                        </span>
                        <span className="num truncate text-[10px] text-muted">
                          {tier.broken
                            ? r.breaks
                              ? `开 ${r.breaks} 次`
                              : "已炸板"
                            : r.breaks
                              ? `开 ${r.breaks} 次`
                              : "未开板"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {tiers.length === 0 ? <div className="px-2 py-6 text-sm text-muted">今天三池都是空的。</div> : null}
          </div>
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            红实框=封住，灰虚框=炸板。点格子看涨停原因（带出处）。上面那个数是<b className="text-fg">封单金额</b>；
            「开 N 次」= 当天涨停被打开 N 次（开过又回封的，比一次没开的弱）。
            {broken.length ? " 炸板票没有封单可算（封单已经撤了），所以显示 —。" : ""}
            {snapshot.bad > 0 ? ` 采集时有 ${snapshot.bad} 行解析失败，已跳过。` : ""}
            {" "}「接近涨停但没封」这一档要盘中实时行情，本页不伪造——去 /review/signals 看池子。
          </div>
        </Panel>
      </div>

      {pick ? <ReasonPopover pick={pick} reasons={reasons} onClose={() => setPick(null)} /> : null}
    </Frame>
  );
}

/**
 * 涨停原因气泡。位置由点击时的格子坐标算出来，夹在视口内，别跑出屏幕。
 * 出处三行分开写：原记录日期 / 来源 / 题材催化日期——混成一行就分不清谁是谁。
 */
function ReasonPopover({
  pick,
  reasons,
  onClose,
}: {
  pick: { card: Card; x: number; y: number };
  reasons: { date: string; reasons: Record<string, LimitUpReason>; sectors: Record<string, { title: string; reason: string; date: string }[]> };
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
          <span className="num text-[11px] text-muted">
            {r.code} · {(r.streak ?? 1)}板
            {pick.card.broken ? " · 已炸板" : ""}
          </span>
        </div>

        {info ? (
          <>
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              {info.primary_concept ? <Tag tone="muted">{info.primary_concept}</Tag> : null}
              {info.theme ? <span className="text-[11px] text-muted">{info.theme}</span> : null}
            </div>
            <div className="text-[12px] leading-relaxed whitespace-pre-line">
              {info.reason.length > 320 ? `${info.reason.slice(0, 320)}…` : info.reason}
            </div>
            {/* 出处：这三行是这个气泡的重点，不是脚注 */}
            <div className="mt-2 rounded border border-line bg-surface-2 px-2 py-1.5 text-[10px] leading-relaxed text-muted">
              <div>
                <b className="text-fg">原记录</b> {ymd(reasons.date) || "日期未知"}
                <span className="float-right">{info.source || "来源未标"}</span>
              </div>
              {sector ? (
                <div className="mt-1 border-t border-line pt-1">
                  <b className="text-fg">题材催化</b> {ymd(sector.date)} · {sector.title.slice(0, 60)}
                  {sector.title.length > 60 ? "…" : ""}
                </div>
              ) : (
                <div className="mt-1 border-t border-line pt-1">该题材今天没有采到催化原文（不是「没有消息」）。</div>
              )}
            </div>
          </>
        ) : (
          <div className="text-[12px] leading-relaxed text-muted">
            这只票今天没采到涨停原因原文——原因来自盘后第三方整理，不是每只票都有。
            <div className="mt-1 text-[10px]">
              原记录 {ymd(reasons.date) || "日期未知"}。这里留空，不编一条理由。
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded border border-line py-1 text-[11px] text-muted hover:bg-surface-2"
        >
          关闭（Esc）
        </button>
      </div>
    </>
  );
}
