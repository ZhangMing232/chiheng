/**
 * 这个文件是干什么的：
 * 「今日决策」页——把「市场在玩什么 → 短线买什么 → 中长线买什么 → 什么时候卖」
 * 按双轨制排在一页里，只放验证过的东西，不放研究层的噪音。
 *
 * 你需要知道的（纪律）：
 * 1. **短线只跟题材，不追高连板**：题材涨停家数≥10 次日 +0.4~0.77%（单调，已验证），
 *    但追三连板+ 每笔 −3.71%（t=−10.19，已证伪）。所以短线买的是「题材的非涨停龙头」。
 * 2. **中长线只认低估值**：value 是唯一实盘为正的策略（+0.5%），但它本质是银行 beta，
 *    不承诺。
 * 3. **什么时候买 = 情绪条件**：广度健康、炸板率<30%、非沸点。冰点不抄（次日 −0.04%）。
 * 4. 每个判断都标数据来源，不编。
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getMarketSnapshot } from "@/lib/market/limit-up.functions";
import { getRegulatoryRadar, getLadder3Day, type RegulatoryRow, type LadderRow } from "@/lib/market/quotes.functions";
import { getThemeHeat, getLimitUpReasons, getSignalReviewed, type ThemeHeatItem, type SignalReviewed, type LimitUpReasonsPayload } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/decision")({
  loader: async () => {
    const [snap, themes, reasons, reviewed, reg, ladder3] = await Promise.all([
      getMarketSnapshot().catch(() => ({ snapshot: null, why: "快照读不到" })),
      getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
      getLimitUpReasons().catch(() => ({ date: "", reasons: {}, sectors: {} }) as LimitUpReasonsPayload),
      getSignalReviewed().catch(() => ({ date: "", ok: 0, warn: 0, skip: 0, signals: [] as SignalReviewed[] })),
      getRegulatoryRadar().catch(() => ({ date: "", rows: [] as RegulatoryRow[] })),
      getLadder3Day().catch(() => ({ dates: [] as string[], ladder: {} as Record<string, Record<string, LadderRow[]>>, promotion: {} })),
    ]);
    return { snap, themes, reasons, reviewed, reg, ladder3 };
  },
  component: DecisionPage,
});

/** 情绪五档 → 动作建议（数据：沸点次日+0.38%，冰点次日−0.04%，动量市不是反转市）。 */
function moodOf(p: { breakRate: number | null; maxStreak: number; ladderCount: number }): {
  band: string;
  tone: "up" | "warn" | "muted" | "down";
  action: string;
} {
  const br = p.breakRate ?? 0;
  if (br >= 0.4) return { band: "退潮", tone: "warn", action: "炸板率高，追高被套概率大，短线少动" };
  if (p.maxStreak >= 5) return { band: "沸点", tone: "up", action: "情绪亢奋，只跟题材不追高连板（追高已证伪）" };
  if (p.ladderCount >= 15 && br < 0.25) return { band: "温和偏热", tone: "up", action: "梯队健康，短线可做题材龙头" };
  if (p.ladderCount < 5) return { band: "冰点", tone: "muted", action: "情绪冷，冰点不抄底（次日 −0.04%），观望" };
  return { band: "温和", tone: "muted", action: "中性，只做有题材支撑的票" };
}

function DecisionPage() {
  const { snap, themes, reasons, reviewed, reg, ladder3 } = Route.useLoaderData();
  const pool = snap.snapshot;

  // 指标条
  const ladder = pool?.summary?.ladder ?? [];
  const limitUpCount = pool?.limitUp?.length ?? 0;
  const ladderCount = ladder.reduce((n, l) => n + (l.streak >= 2 ? l.count : 0), 0);
  const maxStreak = ladder.reduce((m, l) => Math.max(m, l.streak), 0);
  const breakRate = pool?.summary?.breakRate ?? null;
  // 封板率 = 涨停 /（涨停+炸板），对标连板网（85/(85+19)=81.7%）
  const brokenCount = pool?.broken?.length ?? 0;
  const sealRate = limitUpCount + brokenCount > 0 ? limitUpCount / (limitUpCount + brokenCount) : null;
  const mood = moodOf({ breakRate, maxStreak, ladderCount });
  // 较前值：用 3 日梯队的昨天 vs 今天（对标连板网 KPI 条的「较前值」）
  const prev = (() => {
    const ds = ladder3.dates;
    if (ds.length < 2) return null;
    const yDay = ds[ds.length - 2];
    const yLv = ladder3.ladder[yDay] ?? {};
    const yTotal = Object.values(yLv).reduce((n, arr) => n + arr.length, 0);
    const yLadder = Object.entries(yLv).reduce((n, [k, arr]) => n + (Number(k) >= 2 ? arr.length : 0), 0);
    const yTop = Math.max(0, ...Object.keys(yLv).map(Number));
    return { yTotal, yLadder, yTop };
  })();
  const delta = (cur: number, prev: number | null) => {
    if (prev == null) return null;
    const d = cur - prev;
    return d === 0 ? "持平" : d > 0 ? `+${d}` : `${d}`;
  };

  // 短线：题材（涨停家数多的）+ 龙头
  const hotThemes = themes.hot.slice(0, 6);
  // 中长线：低估值长腿
  const longSignals = reviewed.signals.filter((s) => s.leg === "long").slice(0, 8);
  const shortSignals = reviewed.signals.filter((s) => s.leg === "short").slice(0, 8);

  return (
    <Frame wide aside="今日决策">
      <div className="flex flex-col gap-3">
        {/* ── 关键指标条 ── */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-7">
          {[
            { label: "涨停", value: pool ? limitUpCount : "—", tone: "text-up", delta: prev ? delta(limitUpCount, prev.yTotal) : null },
            { label: "连板", value: pool ? ladderCount : "—", tone: "text-up", delta: prev ? delta(ladderCount, prev.yLadder) : null },
            { label: "最高板", value: pool ? `${maxStreak}板` : "—", tone: "text-fg", delta: prev ? delta(maxStreak, prev.yTop) : null },
            { label: "跌停", value: pool ? pool.limitDown.length : "—", tone: "text-down" },
            { label: "炸板率", value: breakRate != null ? `${(breakRate * 100).toFixed(0)}%` : "—", tone: "text-fg" },
            { label: "封板率", value: sealRate != null ? `${(sealRate * 100).toFixed(1)}%` : "—", tone: "text-up" },
            { label: "情绪", value: mood.band, tone: "text-brand-text" },
          ].map((k) => (
            <div key={k.label} className="bg-surface px-3 py-2">
              <div className="text-xs text-muted">{k.label}</div>
              <div className={"num mt-0.5 text-lg font-medium " + k.tone}>{k.value}{k.delta ? <span className="ml-1 text-[10px] font-normal text-muted">较前值{k.delta}</span> : null}</div>
            </div>
          ))}
        </div>

        {/* ── 锚点导航（对标连板网速览）── */}
        <div className="flex flex-wrap items-center gap-2 rounded border border-line bg-surface px-3 py-1.5 text-xs">
          <span className="text-muted">速览</span>
          <a href="#s-main" className="text-accent hover:underline">市场在玩什么</a>
          <a href="#s-short" className="text-accent hover:underline">短线买什么</a>
          <a href="#s-long" className="text-accent hover:underline">中长线买什么</a>
          <a href="#s-reg" className="text-accent hover:underline">监管异动</a>
          <a href="#s-sell" className="text-accent hover:underline">什么时候卖</a>
          <Link to="/" className="text-accent hover:underline">完整复盘 →</Link>
        </div>

        {/* ── 市场在玩什么 + 什么时候买 ── */}
        <Panel id="s-main" title="市场在玩什么 · 什么时候买" note={`${themes.date || "—"} 收盘后 · 情绪${mood.band}`}>
          <div className="flex flex-col gap-3 px-3.5 py-3">
            <div className={`rounded border px-3 py-2 text-sm ${mood.tone === "up" ? "border-up/40 bg-up/5 text-fg" : mood.tone === "warn" ? "border-warn/40 bg-warn/5 text-fg" : "border-line bg-surface2 text-muted"}`}>
              <Tag tone={mood.tone === "up" ? "up" : mood.tone === "warn" ? "warn" : "muted"}>{mood.band}</Tag>
              <span className="ml-2">{mood.action}</span>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-muted">题材热度（涨停家数多的优先，龙头=板内涨幅最高非涨停股）</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {hotThemes.map((r) => (
                  <div key={r.name} className="rounded border border-line bg-surface px-3 py-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="num text-xs text-up">{r.limitUp} 涨停</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between text-[11px] text-muted">
                      <span>均 {r.avg > 0 ? "+" : ""}{r.avg.toFixed(1)}%</span>
                      <span>龙头 {r.leader?.name ?? "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-[11px] leading-relaxed text-muted">
              数据：题材涨停家数 ≥10 → 次日 +0.4%~0.77%（单调，已用 2652 只日 K 验证）；但<b>追三连板+ 每笔 −3.71%（t=−10.19）</b>。
              所以短线买「题材的非涨停龙头」，不追已连板的高位股。
            </div>
          </div>
        </Panel>

        {/* ── 双轨：短线 / 中长线 ── */}
        <div className="grid gap-2 lg:grid-cols-2">
          <Panel id="s-short" title="短线 · 买什么" note={`${reviewed.date || "—"} 竞价审核后`}>
            {shortSignals.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted">今天没有短线信号（题材补涨腿没触发）。</div>
            ) : (
              <div className="flex flex-col gap-1 p-2">
                {shortSignals.map((s) => (
                  <div key={s.code} className="flex items-baseline justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface2">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <Tag tone="up">短线</Tag>
                      <span className="truncate">{s.name}</span>
                      <span className="num text-[10px] text-muted">{s.code}</span>
                    </span>
                    <span className="num shrink-0 text-xs text-muted">挂 {s.buyPrice}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-line px-2 py-2 text-[11px] text-muted">
              口径：热门题材的次强/补涨股（题材补涨腿）。买点看竞价，卖点=断板或情绪退潮。
            </div>
          </Panel>

          <Panel id="s-long" title="中长线 · 买什么" note={`${reviewed.date || "—"} 低估值`}>
            {longSignals.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted">今天没有低估值候选。</div>
            ) : (
              <div className="flex flex-col gap-1 p-2">
                {longSignals.map((s) => (
                  <div key={s.code} className="flex items-baseline justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface2">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <Tag tone="muted">低估值</Tag>
                      <span className="truncate">{s.name}</span>
                      <span className="num text-[10px] text-muted">{s.code}</span>
                    </span>
                    <span className="num shrink-0 text-xs text-muted">挂 {s.buyPrice}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="border-t border-line px-2 py-2 text-[11px] text-muted">
              口径：PE≤18 / PB≤2（唯一实盘为正的策略，+0.5%，但本质是银行 beta，不承诺超额）。
            </div>
          </Panel>
        </div>

        {/* ── 监管异动 ── */}
        <Panel id="s-reg" title="监管异动雷达" note={`${reg.date || "—"} · 3日偏离值≥阈值触发`}>
          {reg.rows.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted">还没算（regulatory-radar.ts 收盘后跑）。</div>
          ) : (
            <div className="flex flex-col gap-1 p-2">
              {reg.rows.filter((r) => r.level !== "正常").slice(0, 15).map((r) => (
                <div key={r.code} className="flex items-baseline justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface2">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <Tag tone={r.level === "已达" ? "warn" : "muted"}>{r.level === "已达" ? "已达" : "临近"}</Tag>
                    <span className="truncate">{r.name}</span>
                    <span className="num text-[10px] text-muted">{r.streak}</span>
                  </span>
                  <span className="num shrink-0 text-xs text-warn">
                    {(r.dev * 100).toFixed(1)}%/{r.threshold.toFixed(0)}%
                  </span>
                </div>
              ))}
              <div className="border-t border-line px-2 pt-1.5 text-[11px] text-muted">
                3日偏离值 = Σ(个股涨幅−基准指数涨幅)。已达=触发异动线，临近=≥0.8×线。高位股停牌风险提示，非利空判定。
              </div>
            </div>
          )}
        </Panel>

        {/* ── 什么时候卖 ── */}
        <Panel id="s-sell" title="什么时候卖" note="持仓的纪律，不是建议">
          <div className="flex flex-col gap-1.5 px-3.5 py-3 text-sm">
            <div className="flex items-start gap-2"><Tag tone="warn">短线</Tag><span>断板（涨停打开）、炸板率升到 40%+、情绪退潮 → 走。</span></div>
            <div className="flex items-start gap-2"><Tag tone="muted">中长线</Tag><span>跌破止损 / 估值到位 / 趋势破位（20 日线拐头）→ 走。</span></div>
            <Link to="/strategies/positions" className="mt-1 text-xs text-accent hover:underline">看实际持仓与止损提醒 →</Link>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
