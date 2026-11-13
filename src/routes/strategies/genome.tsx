/**
 * 策略基因组（/strategies/genome）：AI 提的策略候选 + 每套的回测判决。
 *
 * 这个页面为什么要有（2026-11-05）：
 * 之前 data/strategy-genome.json 和 data/strategy-verdicts.json **只有服务端在读**
 * ——策略闸靠前者决定停不停用某套策略，可「AI 到底在提什么、判得对不对」在界面上
 * 一个字都看不见。用户没法监督 AI 提了什么、判得对不对，这跟「AI 只有请求权」的
 * 前提是矛盾的：看不见就谈不上监督。因子页同理——因子过了 6 关之后有没有长成策略、
 * 那套策略判得怎么样，全是断的。
 *
 * 这一页露三件事：
 * 1. **候选清单**：AI 提的每套 spec（选股/排序/定价/持有/止损/目标）+ 状态
 *    （proposed 待判 / testing 判了样本不够 / promoted 站住 / rejected 判死）。
 * 2. **判决数字**：信噪比、超额、笔数、前后半段是否同向。门槛=白皮书 §4
 *    （聚类 |t|≥2 **且**前后同向）。逐笔 t 不作数——同一天平仓的票共享当天
 *    beta，逐笔 t 能虚高 5~7 倍（10-28 实测）。
 * 3. **它用了哪些因子**：因子→策略融合的溯源（seededFactors）。没这条线，
 *    「因子挖掘完融合」在界面上看不见。
 *
 * 纪律：
 * - 判决门槛写死在服务端（genome-verdict.ts），这一页只**显示**结果，不自己判。
 * - 读不到文件 → 空态带原因，不显示 0 套的假条目（还没提过是正常状态）。
 * - 这一页不改任何账、不下买卖建议。「站住」也只表示过闸门，不等于能上实盘。
 */

import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, Tag } from "@/components/terminal";
import { SectionTabs } from "@/components/section-tabs";
import { BACKTEST_SUB_TABS } from "@/lib/ui/strategy-tabs";
import { StateBlock } from "@/components/state-block";
import { getGenomeView } from "@/lib/market/quotes.functions";
import type { GenomeCandidate } from "@/lib/market/strategy-genome";
import type { BacktestVerdict } from "@/lib/market/strategy-gate";
import { FlaskConical, GitBranch, ShieldCheck, XCircle } from "lucide-react";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

export const Route = createFileRoute("/strategies/genome")({
  loader: async () => {
    return await getGenomeView().catch(() => ({
      candidates: [] as GenomeCandidate[],
      strategyVerdicts: {} as Record<string, BacktestVerdict>,
    }));
  },
  component: GenomePage,
});

/** 候选状态 → 展示用的中文 + 色调。状态机在 strategy-genome.ts（服务端）。 */
const STATUS_META: Record<string, { label: string; tone: "brand" | "up" | "down" | "warn" | "muted" }> = {
  proposed: { label: "待判", tone: "brand" },
  testing: { label: "样本不够·继续攒", tone: "warn" },
  promoted: { label: "站住了", tone: "up" },
  rejected: { label: "判死", tone: "down" },
  tombstone: { label: "墓碑", tone: "muted" },
};

function GenomePage() {
  const { candidates, strategyVerdicts } = useLoaderData({ from: "/strategies/genome" });
  const judged = candidates.filter((c) => c.verdict != null).length;
  const promoted = candidates.filter((c) => c.status === "promoted").length;
  const rejected = candidates.filter((c) => c.status === "rejected").length;
  const waiting = candidates.filter((c) => c.status === "proposed" || c.status === "testing").length;
  const styles = Object.entries(strategyVerdicts);

  return (
    <Frame wide>
      <PixelHeader label="STRATEGY // GENOME" meta="参数与基因视图 · 变体判赢也未必有现役席位" />
      <PixelSummary
        label="STRATEGY // GENOME"
        note="变体判赢也未必有现役席位"
        stats={[
          { label: "候选", value: candidates?.length ?? null, tone: "brand", hero: true },
          { label: "策略判决", value: strategyVerdicts ? Object.keys(strategyVerdicts).length : null, hint: "套" },
        ]}
      />
      <SectionTabs tabs={BACKTEST_SUB_TABS} ariaLabel="回测审计" />
      <div className="flex flex-col gap-4">
        <Panel
          title="策略基因组"
          note="AI 提的每套策略都在这儿过一遍回测。判据写死在服务端：聚类 |t|≥2 且前后同向。"
          bodyClassName="px-3.5 py-3"
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="候选总数" value={candidates.length} />
            <Stat label="已判决" value={judged} />
            <Stat label="站住" value={promoted} tone={promoted > 0 ? "up" : "muted"} />
            <Stat label="判死" value={rejected} tone={rejected > 0 ? "down" : "muted"} />
          </div>
          {waiting > 0 ? (
            <p className="mt-3 text-[12px] text-muted">
              还有 {waiting} 套待判。判决在收盘封印后自动跑（每天一轮全池回测），判完写回本页。
            </p>
          ) : null}
        </Panel>

        <Panel title="候选清单" note="选股条件 / 排序 / 定价 / 出场参数 + 判决数字" bodyClassName="px-3.5 py-3">
          {candidates.length === 0 ? (
            <StateBlock
              kind="empty"
              title="还没有策略候选"
              hint="AI 提的策略 spec 会出现在这儿（收盘后自动进化时产出）。没有候选是正常状态——还没提过，或者这轮全被近亲封禁拒了。"
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {candidates.map((c) => (
                <CandidateCard key={c.id} c={c} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="现役与历史策略的全池判决"
          note="同一套回测跑出来的聚类稳健 t。|t|≤-2 的会被闸门停用。"
          bodyClassName="px-3.5 py-3"
        >
          {styles.length === 0 ? (
            <StateBlock
              kind="empty"
              title="还没有全池判决"
              hint="判决每天收盘后自动刷新一次（全池 2646 只回测）。第一轮跑完这里就有数了。"
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {styles
                .slice()
                .sort((a, b) => a[1].clusterT - b[1].clusterT)
                .map(([key, v]) => (
                  <div key={key} className="rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{key}</span>
                      <span className={`tabular-nums ${v.clusterT <= -2 ? "text-down" : v.clusterT >= 2 ? "text-up" : "text-muted"}`}>
                        t={v.clusterT >= 0 ? "+" : ""}
                        {v.clusterT.toFixed(2)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[12px] text-muted">
                      <span className="tabular-nums">超额 {(v.excess * 100).toFixed(2)}pp</span>
                      <span className="tabular-nums">
                        {v.n} 笔 / {v.days} 天
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Panel>
      </div>
    </Frame>
  );
}

function CandidateCard({ c }: { c: GenomeCandidate }) {
  const meta = STATUS_META[c.status] ?? { label: c.status, tone: "muted" as const };
  const v = c.verdict;
  const seeded = c.seededFactors;
  // P1-3 修误导标签：promoted 只表示过了白皮书 §4 两道关（|t|≥2 且前后同向），
  // 但闸门不卡超额符号——超额为负时它是「稳定输家」，标签写「站住了」会误导成可用。
  // 这里只改**显示文案**，不改成判决口径（改判据需单独拍板）。
  const reversed = c.status === "promoted" && v != null && v.excessPp != null && v.excessPp < 0;
  const statusLabel = reversed ? "反向·不可用" : meta.label;
  const statusTone = reversed ? ("warn" as const) : meta.tone;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{c.name}</span>
          <span className="text-[12px] text-muted tabular-nums">{c.id}</span>
          <Tag tone={statusTone}>{statusLabel}</Tag>
        </div>
        <span className="text-[12px] text-muted">{c.since}</span>
      </div>

      <div className="mt-2 space-y-1 text-[12px]">
        <div className="flex gap-2">
          <span className="w-10 shrink-0 text-muted">选股</span>
          <span className="font-mono text-[12px] leading-relaxed">{c.select.join(" 且 ")}</span>
        </div>
        <div className="flex gap-2">
          <span className="w-10 shrink-0 text-muted">排序</span>
          <span className="font-mono text-[12px]">{c.rankBy}</span>
        </div>
        <div className="flex gap-2">
          <span className="w-10 shrink-0 text-muted">定价</span>
          <span className="font-mono text-[12px]">{c.pricing.shape}</span>
          <span className="text-muted">持有 {c.holdDays} 天 · 止损 {c.stopPct}% · 目标 {c.targetPct}%</span>
        </div>
      </div>

      {seeded && seeded.factorIds.length > 0 ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12px]">
          <GitBranch size={12} className="text-brand" />
          <span className="text-muted">融合自因子</span>
          <span className="font-mono">{seeded.factorIds.join("、")}</span>
          <span className="text-muted">（{seeded.how === "fusion" ? "代码直接熔的" : "AI 声明用的"}）</span>
        </div>
      ) : null}

      {v ? (
        <div className="mt-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2">
          <div className="flex items-center gap-1.5 text-[12px] font-medium">
            <FlaskConical size={12} className="text-brand" />
            全池回测判决
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
            <div>
              <span className="text-muted">信噪比 </span>
              <span className={`tabular-nums ${v.clusteredT != null && Math.abs(v.clusteredT) >= 2 ? "text-up" : "text-muted"}`}>
                {v.clusteredT == null ? "算不出来" : v.clusteredT.toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-muted">超额 </span>
              <span className="tabular-nums">{v.excessPp == null ? "?" : `${v.excessPp >= 0 ? "+" : ""}${v.excessPp.toFixed(2)}pp`}</span>
            </div>
            <div>
              <span className="text-muted">笔数 </span>
              <span className="tabular-nums">{v.trades}</span>
            </div>
            <div>
              <span className="text-muted">前后半段 </span>
              <span>{v.halvesSameSign == null ? "没算" : v.halvesSameSign ? "同向" : "翻脸"}</span>
            </div>
          </div>
          <p className="mt-1.5 text-[12px] text-muted">{v.reason}</p>
        </div>
      ) : null}

      {c.failedGates && c.failedGates.length > 0 ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-down">
          <XCircle size={12} />
          败于：{c.failedGates.join(" / ")}
        </div>
      ) : null}

      {c.status === "promoted" ? (
        reversed ? (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-warn">
            <ShieldCheck size={12} />
            过了白皮书 §4 的两道关（|t|≥2 且前后同向），但**超额为负**——反向信号，不能进实盘，要单独拍板。
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-up">
            <ShieldCheck size={12} />
            过了白皮书 §4 的两道关（|t|≥2 且前后同向）——但**还没进实盘**，要单独拍板。
          </div>
        )
      ) : null}

      {c.note ? <p className="mt-2 text-[12px] leading-relaxed text-muted">{c.note}</p> : null}
    </div>
  );
}
