/**
 * 情绪周期（/cycle）——把「现在处在周期的哪个位置」摊开给人看。
 *
 * 三块内容，全部由 data/history/cycle/series.json 算，不现场拉网：
 * 1. 阶段色带：近 60 个交易日，柱高=温度，颜色=六档阶段。
 * 2. 板位热力图：近 30 个交易日 × 板位，色深=家数。**用单一色阶不用红绿**——
 *    这里的"深"表示数量多，不表示涨跌，红绿留给涨跌（这条是跟弈盘学的）。
 * 3. 阶段转移矩阵 + 历史同景：今天某阶段，次日落在哪、次日全池等权涨跌怎么分布。
 *
 * 纪律（页面上必须写出来，不能只写在代码里）：
 * - 阶段是**我们自己的口径**（温度档位 + 5 日温度变化），不是行业标准。
 * - 样本 <30 一律标「样本不足」，不给确定性结论。
 * - 这是历史统计，不是预测，也不是买卖信号（red-line 不允许）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getCycleSeries } from "@/lib/market/quotes.functions";
import { PHASES, PHASE_TONE, nextDayOutcome, promotion, transferMatrix, type Phase } from "@/lib/market/cycle";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

export const Route = createFileRoute("/cycle")({
  loader: async () => getCycleSeries().catch(() => ({ date: "", series: [], meta: null })),
  component: CyclePage,
});

/** 阶段 → CSS 变量（动态色不能用 Tailwind 类名拼，必须走内联 style）。 */
function toneOf(phase: Phase | string): string {
  const key = (PHASE_TONE as Record<string, string>)[phase];
  return key ? `var(--color-${key})` : "var(--color-muted)";
}

const BAR_DAYS = 60;
const HEAT_DAYS = 30;
const TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function CyclePage() {
  const { series, meta } = Route.useLoaderData();
  if (series.length === 0) {
    return (
      <Frame wide aside="情绪周期">
      <PixelHeader label="CYCLE // MOOD" meta="情绪周期 · 冰点/修复/升温/高潮/降温/退潮六档" />
        <Panel title="情绪周期">
          <StateBlock kind="empty" title="还没算" hint="跑一次 scripts/cycle-history.ts 就有（扫本地 K 线，不联网）。" />        </Panel>
      </Frame>
    );
  }

  const last = series[series.length - 1]!;
  const bars = series.slice(-BAR_DAYS);
  const heat = series.slice(-HEAT_DAYS);
  const maxTemp = Math.max(...bars.map((d) => d.temp), 1);
  const maxCount = Math.max(1, ...heat.flatMap((d) => TIERS.map((t) => d.byTier[String(t)] ?? 0)));

  const cells = transferMatrix(series);
  const todayPhase = last.phase as Phase;
  const scenes = PHASES.map((p) => ({ phase: p, ...nextDayOutcome(series, p) })).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0));

  // 晋级率：用最近两天算 1→2 / 2→3 …… 给一行"接力手感"
  const yest = series[series.length - 2];
  const promos = yest && last ? [1, 2, 3, 4].map((t) => ({ tier: t, ...promotion(yest.byTier, last.byTier, t) })) : [];

  const fmtPct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
  const fmtRet = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

  return (
    <Frame
      wide
      aside={
        /* 顶栏这一行放真实状态，不重复页名（页名在第一行页头里已经有了） */
        <span className="num text-xs text-muted">
    <PixelHeader label="CYCLE // MOOD" meta="情绪周期 · 冰点/修复/升温/高潮/降温/退潮六档" />
    <PixelSummary
      label="CYCLE // NOW"
      note={
        <span title="本页阶段按情绪温度分档；/today 的『退潮/沸点』按炸板率与连板数判，两者口径不同">
          {last.date} · 阶段按温度分档（与今日页炸板率口径不同）
        </span>
      }
      stats={[
        { label: "当前阶段", value: last.phase, tone: "brand", hero: true },
        { label: "涨停", value: last.limitUp ?? null, tone: "up" },
        { label: "连板", value: last.ladder ?? null },
        { label: "最高板", value: last.maxStreak, tone: "warn" },
      { label: "情绪温度", value: last.temp?.toFixed?.(0) ?? last.temp, tone: "brand", hint: last.tempDelta5 != null ? `5日 ${last.tempDelta5 > 0 ? "+" : ""}${last.tempDelta5.toFixed(0)}` : undefined },
      ]}
    />
          {last.date} · 温度 {last.temp.toFixed(1)} · {todayPhase}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {/* ── 当前状态 ── */}
        <Panel
          title="当前阶段"
          note={meta?.generatedAt ? `数据 ${meta.generatedAt.slice(0, 10)} · ${last.date}` : last.date}
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-3 py-3">
            <div>
              <div className="text-[12px] text-muted">阶段</div>
              <div className="num text-2xl font-medium" style={{ color: toneOf(todayPhase) }}>
                {todayPhase}
              </div>
            </div>
            <div>
              <div className="text-[12px] text-muted">温度</div>
              <div className="num text-2xl font-medium">{last.temp.toFixed(1)}</div>
            </div>
            <div>
              <div className="text-[12px] text-muted">较 5 日前</div>
              <div className={"num text-2xl font-medium " + (last.tempDelta5 >= 0 ? "text-up" : "text-down")}>
                {last.tempDelta5 >= 0 ? "+" : ""}
                {last.tempDelta5.toFixed(1)}
              </div>
            </div>
            <div>
              <div className="text-[12px] text-muted">涨停 / 连板 / 最高</div>
              <div className="num text-lg">
                {last.limitUp} / {last.ladder} / {last.maxStreak} 板
              </div>
            </div>
            <div>
              <div className="text-[12px] text-muted">全池等权</div>
              <div className={"num text-lg " + (last.eqReturn >= 0 ? "text-up" : "text-down")}>{fmtRet(last.eqReturn)}</div>
            </div>
            {promos.length > 0 ? (
              <div>
                <div className="text-[12px] text-muted">昨日晋级率</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {promos.map((p) => (
                    <span key={p.tier} className="num">
                      {p.tier}→{p.tier + 1}板{" "}
                      <b className={p.rate != null && p.rate >= 0.3 ? "text-up" : "text-muted"}>
                        {p.promoted}/{p.total}
                        {p.rate != null ? ` ${(p.rate * 100).toFixed(0)}%` : ""}
                      </b>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          {meta?.note ? (
            <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
              口径：{meta.note}。阶段是本项目的推导口径，不是行业标准；样本不足时只看数字不下结论。
            </div>
          ) : null}
        </Panel>

        {/* ── 阶段色带 ── */}
        <Panel title="阶段色带" note={`近 ${bars.length} 个交易日 · 柱高=温度`}>
          <div className="px-3 py-3">
            <div className="flex h-28 items-end gap-[2px]">
              {bars.map((d) => (
                <div
                  key={d.date}
                  className="group relative flex-1 rounded-t-sm"
                  style={{ height: `${Math.max(4, (d.temp / maxTemp) * 100)}%`, background: toneOf(d.phase) }}
                  title={`${d.date}｜${d.phase}｜温度 ${d.temp.toFixed(1)}｜涨停 ${d.limitUp}｜等权 ${fmtRet(d.eqReturn)}`}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted">
              <span>{bars[0]?.date}</span>
              <span>{bars[bars.length - 1]?.date}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {PHASES.map((p) => (
                <span key={p} className="flex items-center gap-1 text-[12px] text-muted">
                  <span className="h-2 w-2 rounded-sm" style={{ background: toneOf(p) }} aria-hidden />
                  {p}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        {/* ── 板位热力图 ── */}
        <Panel title="板位热力图" note={`近 ${heat.length} 个交易日 · 色深=家数（平方根标度，不是涨跌）`}>
          <div className="overflow-x-auto px-3 py-3 scroll-slim">
            {/* min-w：窄屏必须横向滚，不能让 30 天挤进 390px 把日期压成一团 */}
            <table className="w-full min-w-[760px] text-[12px]">
              <thead>
                <tr>
                  <th className="w-10 text-left font-normal text-muted">板位</th>
                  {heat.map((d) => (
                    <th key={d.date} className="px-[1px] text-center font-normal text-muted" title={d.date}>
                      <span className="num text-[10px] leading-none">{d.date.slice(8)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...TIERS].reverse().map((t) => (
                  <tr key={t}>
                    <td className="num text-muted">{t === 9 ? "9+" : t}</td>
                    {heat.map((d) => {
                      const v = d.byTier[String(t)] ?? 0;
                      // 平方根标度：线性标度下 maxCount 是 100+，1 家和 10 家的色值几乎一样（0.0686 vs 0.0685），
                      // 「色深=家数」在高板位那一半完全退化。开方后 1/5/10 家能分开，低板位的 39~102 也不会糊成一片。
                      const alpha = v === 0 ? 0 : 0.12 + Math.sqrt(v / maxCount) * 0.88;
                      return (
                        <td key={d.date} className="p-[1px]">
                          <div
                            className="grid h-5 place-items-center rounded-sm text-[10px]"
                            style={{
                              background: v === 0 ? "var(--color-surface-2)" : `color-mix(in srgb, var(--color-brand) ${alpha * 100}%, var(--color-surface))`,
                              // 深格配白字，浅格配正文色（不能用 muted：暗色主题下 muted 在近黑底上几乎看不见）
                              color: alpha > 0.5 ? "#fff" : "var(--color-fg)",
                            }}
                            title={`${d.date}｜${t}板 ${v} 家`}
                          >
                            {v || ""}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── 转移矩阵 ── */}
        <Panel title="阶段转移" note={`今日「${todayPhase}」行已高亮 · 相邻交易日`}>
          <div className="overflow-x-auto px-3 py-3 scroll-slim">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr>
                  <th className="w-14 text-left font-normal text-muted">今日↓ / 次日→</th>
                  {PHASES.map((p) => (
                    <th key={p} className="px-1 text-center font-normal" style={{ color: toneOf(p) }}>
                      {p}
                    </th>
                  ))}
                  <th className="text-right font-normal text-muted">样本</th>
                </tr>
              </thead>
              <tbody>
                {PHASES.map((from) => {
                  const row = cells.filter((c) => c.from === from);
                  const total = row.reduce((n, c) => n + c.count, 0);
                  const isToday = from === todayPhase;
                  return (
                    <tr key={from} className={isToday ? "bg-surface-2" : ""}>
                      <td className="py-1" style={{ color: toneOf(from) }}>
                        {from}
                      </td>
                      {PHASES.map((to) => {
                        const c = row.find((x) => x.to === to)!;
                        const a = c.rate === 0 ? 0 : 0.08 + c.rate * 0.92;
                        return (
                          <td key={to} className="p-[1px]">
                            <div
                              className="num grid h-7 place-items-center rounded-sm text-[12px]"
                              style={{
                                background: c.rate === 0 ? "transparent" : `color-mix(in srgb, ${toneOf(from)} ${a * 100}%, var(--color-surface))`,
                                color: a > 0.5 ? "#fff" : "var(--color-fg)",
                              }}
                              title={`${from}→${to}：${c.count} 次 / ${(c.rate * 100).toFixed(1)}%`}
                            >
                              {c.rate === 0 ? "" : `${(c.rate * 100).toFixed(0)}%`}
                            </div>
                          </td>
                        );
                      })}
                      <td className="num text-right text-muted">{total}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-2 text-[12px] leading-relaxed text-muted">
              读法：行是今天所处阶段，列是次日落到哪。占比按行归一（同一行加起来 100%）。
              样本少于 30 的阶段，这一行只能当参考，不能当规律。
            </div>
          </div>
        </Panel>

        {/* ── 历史同景 ── */}
        <Panel title="历史同景 · 次日怎么走" note="全池等权的次日收益分布（不是指数）">
          <div className="overflow-x-auto scroll-slim">
            <table className="data-table w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">阶段</th>
                  <th className="text-right">样本</th>
                  <th className="text-right">次日上涨概率</th>
                  <th className="text-right">次日均值</th>
                  <th className="text-left">证据</th>
                </tr>
              </thead>
              <tbody>
                {scenes.map((s) => (
                  <tr key={s.phase}>
                    <td className="py-1" style={{ color: toneOf(s.phase) }}>
                      {s.phase}
                    </td>
                    <td className="num text-right">{s.n}</td>
                    <td className="num text-right">{fmtPct(s.winRate)}</td>
                    <td className={"num text-right " + (s.mean != null && s.mean >= 0 ? "text-up" : "text-down")}>
                      {fmtRet(s.mean)}
                    </td>
                    <td>
                      <Tag tone={s.reliable ? "muted" : "warn"}>{s.reliable ? "样本够" : "样本不足"}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            上涨概率是最基本的基线：全市场任何一天上涨概率本来就在 50% 上下。除非某阶段明显偏离，
            否则不要把它读成「这个阶段该买」。真实可部署的判断必须过六切片 + 样本外，这里只给历史分布。
          </div>
        </Panel>

        {/* ── 今日推演（只做情景，不做动作）── */}
        <Panel title="次日情景" note="按今天的阶段查历史，不是预测">
          <div className="flex flex-col gap-2 px-3 py-3 text-sm leading-relaxed">
            {(() => {
              const row = cells.filter((c) => c.from === todayPhase).sort((a, b) => b.count - a.count);
              const top = row.slice(0, 3).filter((c) => c.count > 0);
              const scene = scenes.find((s) => s.phase === todayPhase);
              return (
                <>
                  <div>
                    今日处于「<b style={{ color: toneOf(todayPhase) }}>{todayPhase}</b>」，
                    历史上次日最常落在：
                    {top.length === 0 ? "（该阶段样本为 0）" : top.map((c) => `${c.to} ${(c.rate * 100).toFixed(0)}%`).join(" · ")}
                    。
                  </div>
                  {scene && scene.n > 0 ? (
                    <div className="text-muted">
                      该阶段历史 {scene.n} 次，次日全池等权均值 {fmtRet(scene.mean)}、上涨概率 {fmtPct(scene.winRate)}
                      {scene.reliable ? "" : "（样本不足，只作观察）"}。
                    </div>
                  ) : null}
                  <div className="border-t border-line pt-2 text-[12px] text-muted">
                    只给情景概率与裁决点，不给买卖动作建议。真正下单前看 /decision 的闸门与 /strategies/positions 的持仓。
                  </div>
                </>
              );
            })()}
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
