/**
 * 「失败归因」子页（/arena/autopsy）——把「亏在哪、为什么亏」摊到页面上。
 *
 * 两条线：
 * 1. 逐笔亏损归因：按退出原因（止损/跳空/到期/未记）分 cause，给笔数、均亏、
 *    最差、样例，和「这个机制为什么会吃掉钱」的因果解释。
 * 2. 挑战者判决归因：每次转正/淘汰/停跑一条，带「为什么」和双方均值。
 *
 * 纪律：
 * - 老账没记退出原因 → 显式标「退出原因未记（老账）」，不拿价格反推原因。
 * - 读不到账本/没有亏损 → 空态带原因，不显示 0 笔的假条目。
 * - 这一页只归因，不改任何账、不下买卖建议。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat } from "@/components/terminal";
import { SectionTabs } from "@/components/section-tabs";
import { StateBlock } from "@/components/state-block";
import { getLossAttribution } from "@/lib/market/quotes.functions";
import {
  CAUSE_LABEL,
  VERDICT_CAUSE_LABEL,
  type ChallengerVerdict,
  type LossCause,
  type TradeLossSummary,
} from "@/lib/market/loss-attrib";

const ARANA_TABS = [
  { to: "/arena/signals", label: "每日信号" },
  { to: "/arena/strategies", label: "策略管理" },
  { to: "/arena/tracking", label: "战绩跟踪" },
  { to: "/arena/autopsy", label: "失败归因" },
];

export const Route = createFileRoute("/arena/autopsy")({
  loader: async (): Promise<{ summary: TradeLossSummary; verdicts: ChallengerVerdict[] }> => {
    return await getLossAttribution().catch(() => ({
      summary: { total: 0, losses: 0, byCause: [], missing: ["读不到账本"] },
      verdicts: [] as ChallengerVerdict[],
    }));
  },
  component: AutopsyPage,
});

function pctClass(v: number): string {
  return v >= 0 ? "text-up" : "text-down";
}

function AutopsyPage() {
  const { summary, verdicts } = Route.useLoaderData();

  return (
    <Frame aside="策略竞技场">
      <Panel title="失败归因" note="亏在哪、为什么亏——按退出原因拆，用因果解释，不给买卖建议。">
        <div className="flex flex-col gap-4 px-4 py-3">
          <SectionTabs tabs={ARANA_TABS} ariaLabel="竞技场子页面" />

          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            <Stat label="已平仓亏损" value={String(summary.losses)} hint="笔（net<0）" className="bg-surface" />
            <Stat label="亏损原因类别" value={String(summary.byCause.length)} hint="按退出原因分" className="bg-surface" />
            <Stat label="挑战者判决档案" value={String(verdicts.length)} hint="转正/淘汰/停跑" className="bg-surface" />
            <Stat
              label="最大的亏损类"
              value={summary.byCause[0] ? CAUSE_LABEL[summary.byCause[0].cause as LossCause] : "—"}
              hint={summary.byCause[0] ? `${summary.byCause[0].count} 笔` : "还没有"}
              className="bg-surface"
            />
          </div>

          {summary.byCause.length === 0 ? (
            <StateBlock
              kind="empty"
              title="还没有可归因的亏损"
              hint="收盘结算后，已平仓且亏钱的交易会在这里按退出原因分类。老账没有退出原因，会单列「退出原因未记」并明说判不了。"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {summary.byCause.map((c) => (
                <div key={c.cause} className="rounded border border-line bg-surface p-3 text-xs">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{CAUSE_LABEL[c.cause as LossCause]}</span>
                    <span className="tabular-nums text-muted">
                      {c.count} 笔 · 均 <span className={pctClass(c.avgRetPct)}>{c.avgRetPct}%</span> · 最差{" "}
                      <span className="text-down">{c.worstPct}%</span>
                      {c.systematicCount > 0 ? ` · 含系统性 ${c.systematicCount} 笔` : ""}
                    </span>
                  </div>
                  <p className="mt-1 leading-relaxed text-muted">{c.causal}</p>
                  {c.examples.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
                      <span>样例：</span>
                      {c.examples.map((e) => (
                        <span key={e.id} className="tabular-nums">
                          {e.name ?? e.id} <span className={pctClass(e.retPct)}>{e.retPct}%</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {summary.missing.length > 0 ? (
            <div className="rounded border border-warn bg-warn-soft px-3 py-2 text-[11px] text-warn">
              读不到的数据（不是没有）：{summary.missing.join("；")}
            </div>
          ) : null}

          <Panel title="挑战者判决归因" note="为什么转正 / 为什么淘汰——判决规则现在从 data/challenger-rule.json 读，不再写死。">
            {verdicts.length === 0 ? (
              <div className="px-3.5 py-4">
                <StateBlock
                  kind="empty"
                  title="还没有判决档案"
                  hint="挑战者攒够样本、被判转正/淘汰/停跑时，这里会留下一条带因果的档案。"
                />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {verdicts
                  .slice()
                  .sort((a, b) => b.at.localeCompare(a.at))
                  .slice(0, 20)
                  .map((v, i) => (
                    <li key={`${v.id}-${v.at}-${i}`} className="px-3.5 py-2.5 text-xs">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {v.name} <span className="text-[10px] text-muted">{v.style}</span>
                        </span>
                        <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px]">
                          {VERDICT_CAUSE_LABEL[v.cause]}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 tabular-nums text-muted">
                        <span>{v.params}</span>
                        <span>挑战者 {v.chalN} 笔均 {v.chalMeanPct ?? "—"}%</span>
                        <span>冠军 {v.champN} 笔 {v.champMeanPct ?? "—"}%</span>
                        <span className="text-[10px]">{v.day}</span>
                      </div>
                      <p className="mt-1 leading-relaxed text-muted">{v.causal}</p>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>

          <p className="px-1 text-xs leading-relaxed text-muted">
            归因是「复盘失败」不是「自动改策略」。下一步动作走 AI 诊断的建议 + 优化闭环：
            tunable 规则（提前否决时间盒）自动生效并留审计，核心阈值（起判笔数 / Welch t）只进待确认、你拍板才改。
          </p>
        </div>
      </Panel>
    </Frame>
  );
}
