/**
 * 这个文件是干什么的：
 * 因子与策略的 AI 闭环面板（2026-10-13 从 /ai 页抽出，区块代码原样搬运）。
 *
 * 为什么抽出来：/ai 页原本把「AI 接口配置 + 进化控制台 + 用量监控」和
 * 「因子待验队列 + 决策者记分牌 + 挑战者提名」混在一页——后者是因子/策略的研究闭环，
 * 属于因子发掘页的领域。用户 2026-10-13 指出「AI 管理里面还有很多因子类或者其他功能的」。
 * 现在这一块独立成组件挂在因子发掘页，/ai 页只留 AI 接入本身。
 *
 * 数据与动作：serverFn 全部来自 quotes.functions（和原来一致），
 * 不依赖宿主页面 loader——挂到任何页面都不用改那边。
 */

import { useEffect, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Table, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import {
  getAIStatus,
  getChallengerSamples,
  getChallengers,
  getDecisionLedger,
  getFactorQueue,
  runFactorAI,
  runStrategyAI,
} from "@/lib/market/quotes.functions";
import type { DecisionLedger } from "@/lib/market/decision-ledger";
import type { QueueEntry, QueuePayload } from "@/lib/market/factor-queue";
import type { Challenger } from "@/lib/market/challenger";
import { STYLES } from "@/lib/market/strategies";

/** 区块外壳（ai.tsx 的 Section 是页面私有组件，这里自带一份同款）。 */
function Section({ id, title, hint, children }: { id?: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded border border-line bg-surface">
      <div className="border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const QUEUE_STATUS: Record<QueueEntry["status"], { label: string; className: string }> = {
  pending: { label: "待验", className: "text-fg" },
  tested: { label: "在验·未过", className: "text-warn" },
  passed: { label: "已过 6 关", className: "text-up" },
  monitoring: { label: "观察中·有衰减迹象", className: "text-warn" },
  decayed: { label: "已衰减·停跑", className: "text-muted line-through" },
  tombstone: { label: "已淘汰", className: "text-muted line-through" },
};

const CHAL_STATUS: Record<Challenger["status"], { label: string; className: string }> = {
  running: { label: "在跑", className: "text-fg" },
  promoted: { label: "已转正", className: "text-up" },
  rejected: { label: "已淘汰", className: "text-down" },
  inconclusive: { label: "停跑·未分胜负", className: "text-muted" },
};

type Loader = {
  queue: QueuePayload;
  ai: { allowed: boolean; configured: boolean };
  chal: Challenger[];
  /** 在跑挑战者攒到的已平仓样本数（判决双方各要 30 笔），id → {n, target, champN}。 */
  samples: Record<string, { n: number; target: number; champN: number }>;
  ledger: { allowed: boolean; ledger: DecisionLedger | null };
};

/** 决策者记分牌（区块代码从 ai.tsx 原样搬来）。 */
function LedgerSection({ ledger }: { ledger: Loader["ledger"] }) {
  if (!ledger.allowed) {
    return <p className="px-3.5 py-3 text-xs text-muted">只有主人账号能看记分牌。</p>;
  }
  const L = ledger.ledger;
  if (!L) {
    return (
      <div className="px-3.5 py-3">
        <StateBlock kind="empty" title="记分牌还没数据" hint="第一次因子判决 / 挑战者判决跑完后自动有。判定产物在 data/ 下，不在 git 里。" />
      </div>
    );
  }
  const col = (title: string, f: DecisionLedger["factors"]["ai"], c: DecisionLedger["challengers"]["ai"], deaths: number) => (
    <div className="bg-surface px-3.5 py-3">
      <div className="text-xs font-medium text-fg">{title}</div>
      <dl className="mt-2 space-y-1 text-xs text-muted">
        <div className="flex justify-between"><dt>因子提议</dt><dd className="text-fg">{f.proposed}</dd></div>
        <div className="flex justify-between"><dt>过 6 关</dt><dd className={f.passed > 0 ? "text-up" : "text-fg"}>{f.passed}{f.proposed > 0 ? `（${Math.round((f.passed / f.proposed) * 100)}%）` : ""}</dd></div>
        <div className="flex justify-between"><dt>在验</dt><dd className="text-fg">{f.pending}</dd></div>
        <div className="flex justify-between"><dt>淘汰/衰减</dt><dd className="text-down">{f.dead}{deaths > f.dead ? `（死因档案另记 ${deaths} 条）` : ""}</dd></div>
        <div className="mt-2 border-t border-line pt-2 flex justify-between"><dt>挑战者提名</dt><dd className="text-fg">{c.proposed}</dd></div>
        <div className="flex justify-between"><dt>已转正</dt><dd className={c.promoted > 0 ? "text-up" : "text-fg"}>{c.promoted}</dd></div>
        <div className="flex justify-between"><dt>已淘汰 / 未决</dt><dd className="text-fg">{c.rejected} / {c.inconclusive}</dd></div>
      </dl>
    </div>
  );
  return (
    <div className="grid gap-px bg-line sm:grid-cols-2">
      {col("AI 提议", L.factors.ai, L.challengers.ai, L.tombstones.ai)}
      {col("人工登记", L.factors.manual, L.challengers.manual, L.tombstones.manual)}
    </div>
  );
}

/** 因子 + 策略两层 AI 闭环（队列 / 记分牌 / 挑战者）。挂在因子发掘页。 */
export function FactorLoopPanels() {
  const router = useRouter();
  const [data, setData] = useState<Loader | null>(null);
  const [factorMsg, setFactorMsg] = useState<string | null>(null);
  const [stratMsg, setStratMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"factor" | "strategy" | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [queue, chalRes, samplesRes, ledgerRes, aiRes] = await Promise.all([
        getFactorQueue().catch((e: unknown): QueuePayload => ({ entries: [], missing: messageOf(e) })),
        getChallengers().then((res) => res.list).catch((): Challenger[] => []),
        getChallengerSamples().catch((): Loader["samples"] => ({})),
        getDecisionLedger().catch((): Loader["ledger"] => ({ allowed: false, ledger: null })),
        getAIStatus().catch(() => ({ allowed: false, configured: false })),
      ]);
      if (!alive) return;
      setData({ queue, chal: chalRes, samples: samplesRes, ledger: ledgerRes, ai: { allowed: aiRes.allowed, configured: aiRes.configured } });
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return <StateBlock kind="loading" title="正在读闭环数据" hint="队列、挑战者、记分牌" />;
  const { queue, chal, samples, ledger, ai } = data;

  const runFactor = async () => {
    setBusy("factor");
    setFactorMsg(null);
    try {
      const res = await runFactorAI();
      setFactorMsg(
        res.ok
          ? `本轮提议 ${res.proposed} 个进队列` +
              (res.rejected > 0 ? `，拒了 ${res.rejected} 个（${res.rejectReasons.slice(0, 2).join("；")}${res.rejectReasons.length > 2 ? "…" : ""}）` : "") +
              "。收盘后记账进程会自动跑 6 关判决（等不及也可以手动 BT_FACTOR=1）。"
          : `没跑成：${res.error ?? "未知原因"}`,
      );
      await router.invalidate();
    } catch (err) {
      setFactorMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  const runStrategy = async () => {
    setBusy("strategy");
    setStratMsg(null);
    try {
      const res = await runStrategyAI();
      setStratMsg(
        res.ok
          ? `本轮提名 ${res.proposed} 个挑战者` +
              (res.rejected > 0 ? `，拒了 ${res.rejected} 个（${res.rejectReasons.slice(0, 2).join("；")}${res.rejectReasons.length > 2 ? "…" : ""}）` : "") +
              "。记账进程当天开始并行攒样本（每策略每天限 1 只）。"
          : `没跑成：${res.error ?? "未知原因"}`,
      );
      await router.invalidate();
    } catch (err) {
      setStratMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  const styleName = (id: string) => STYLES.find((s) => s.id === id)?.name ?? id;
  const runningCount = chal.filter((c) => c.status === "running").length;

  return (
    <div className="space-y-3">
      <Section
        title="决策者记分牌"
        hint="同一个问题用记账回答：AI 做的决策到底行不行。因子层看 6 关过关率，策略层看挑战者转正率，两列对照——AI 列长期难看就该怀疑闭环，不该怀疑判据。数据缺哪边就空哪边，不补 0 冒充。"
      >
        <LedgerSection ledger={ledger} />
      </Section>

      <Section
        id="ai-queue"
        title="因子层：待验队列"
        hint="AI 读最近一轮 6 关判决，针对败因提 1~3 个新假设；进队列后收盘自动进 6 关检验，连续 2 次没过自动淘汰，过关/淘汰推微信。"
      >
        <div className="border-b border-line px-3.5 py-2">
          {ai.allowed ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy !== null || !ai.configured}
                onClick={() => void runFactor()}
                className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "factor" ? "AI 思考中…" : "让 AI 提议一轮新因子"}
              </button>
              {factorMsg ? <span className="min-w-0 text-xs text-muted">{factorMsg}</span> : null}
            </div>
          ) : (
            <p className="text-xs text-muted">主人账号登录后可运行 AI 闭环。</p>
          )}
        </div>
        <div className="px-3.5 py-3">
          {queue.entries.length > 0 ? (
            <Table className="data-table" caption="待验队列：AI 或人工预登记的因子，跑 BT_FACTOR=1 时附加进 6 关检验">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>状态</th>
                  <th className={thClass("text-left")}>因子</th>
                  <th className={thClass()}>方向</th>
                  <th className={thClass("text-left")}>表达式</th>
                  <th className={thClass("text-left")}>经济逻辑</th>
                  <th className={thClass()}>跑过/失败</th>
                  <th className={thClass()}>运气线 DSR</th>
                  <th className={thClass()}>IC / ICIR</th>
                </tr>
              </thead>
              <tbody>
                {[...queue.entries].reverse().map((e) => {
                  const st = QUEUE_STATUS[e.status];
                  return (
                    <tr key={e.id} className={`border-b border-line last:border-b-0 ${e.status === "tombstone" ? "opacity-50" : ""}`}>
                      <td data-l="状态" className={`px-2.5 py-1.5 ${st.className}`}>
                        {st.label}
                      </td>
                      <td data-l="因子" className="px-2.5 py-1.5 text-left">
                        <span className="font-medium">{e.name}</span>
                        <span className="ml-1.5 text-[11px] text-muted">{e.id}</span>
                        {e.note ? <span className="ml-1.5 text-[11px] text-muted">（{e.note}）</span> : null}
                      </td>
                      <td data-l="方向" className="px-2.5 py-1.5">
                        {e.direction > 0 ? "正向" : "反向"}
                      </td>
                      <td data-l="表达式" className="px-2.5 py-1.5 font-mono text-[11px] text-muted">
                        {e.expr}
                      </td>
                      <td data-l="经济逻辑" className="max-w-[36ch] px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
                        {e.rationale}
                      </td>
                      <td data-l="跑过/失败" className="px-2.5 py-1.5 text-[11px] text-muted">
                        {e.runs} 次{e.failCount > 0 ? ` · 连续失败 ${e.failCount}` : ""}
                      </td>
                      <td
                        data-l="运气线 DSR"
                        className="px-2.5 py-1.5 text-[11px]"
                        title="试 N 个因子时运气最好的显著性基准线：per-period 夏普高过这条线=不像是搜出来的。只展示，不改 6 关判决。"
                      >
                        {e.lastDsr ? (
                          <span className={e.lastDsr.survives ? "text-emerald-500" : "text-amber-500"}>
                            {(e.lastDsr.value * 100).toFixed(0)}%{e.lastDsr.survives ? " ✓" : ""}
                            <span className="ml-1 text-muted">线 {(e.lastDsr.expectedMax * 100).toFixed(0)}% · N={e.lastDsr.nTrials}</span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td
                        data-l="IC / ICIR"
                        className="px-2.5 py-1.5 text-[11px]"
                        title="逐日横截面「因子值 vs 未来超额」的 Spearman 秩相关：IC=均值，ICIR=均值/标准差（日频）。读数按原始方向存，对照「方向」列看正负。只展示，不改 6 关判决。"
                      >
                        {e.lastIc && e.lastIc.mean != null ? (
                          <span>
                            <span className={e.lastIc.mean * e.direction > 0 ? "text-emerald-500" : "text-amber-500"}>
                              IC {e.lastIc.mean >= 0 ? "+" : ""}
                              {e.lastIc.mean.toFixed(3)}
                            </span>
                            {e.lastIc.icir != null ? (
                              <span className="ml-1 text-muted">
                                ICIR {e.lastIc.icir >= 0 ? "+" : ""}
                                {e.lastIc.icir.toFixed(2)}
                              </span>
                            ) : null}
                            <span className="ml-1 text-muted">{e.lastIc.days} 天</span>
                          </span>
                        ) : (
                          <span className="text-muted">{e.lastIc ? "样本不足" : "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <StateBlock
              kind="empty"
              title="待验队列是空的"
              hint={ai.allowed ? "点上面的「让 AI 提议一轮新因子」；进队列后收盘自动判决，过关/淘汰会推微信。开自动进化后每晚自己转。" : "主人账号配置 AI 接口后可以自动补充新因子。"}
            />
          )}
          {queue.missing ? <p className="mt-2 text-[11px] text-muted">{queue.missing}（还没跑过，正常）</p> : null}
        </div>
      </Section>

      <Section
        title="策略层：冠军-挑战者提名"
        hint="AI 只许调出场参数（持有天数/止损/目标价），选股名单不许动。提名通过的直接开跑纸面（每策略每天限 1 只），攒满 30 笔后 Welch t ≥ 1.5 转正 / t ≤ −2 淘汰——判决在记账进程里，AI 碰不到。名单详情在策略追踪页。"
      >
        <div className="border-b border-line px-3.5 py-2">
          {ai.allowed ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy !== null || !ai.configured}
                onClick={() => void runStrategy()}
                className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "strategy" ? "AI 思考中…" : "让 AI 提名挑战者"}
              </button>
              {stratMsg ? <span className="min-w-0 text-xs text-muted">{stratMsg}</span> : null}
            </div>
          ) : (
            <p className="text-xs text-muted">主人账号登录后可运行 AI 闭环。</p>
          )}
        </div>
        <div className="px-3.5 py-3">
          {chal.length > 0 ? (
            <ul className="space-y-1">
              {chal.slice(-12).reverse().map((c) => {
                const st = CHAL_STATUS[c.status];
                return (
                  <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className={`shrink-0 ${st.className}`}>{st.label}</span>
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted">
                      {styleName(c.style)} · 持有{c.holdDays ?? "沿用冠军"}天 · 止损{c.stopPct ?? "沿用冠军"}% · 目标
                      {c.targetPct ?? "沿用冠军"}% · {c.since} 开跑
                    </span>
                    {samples[c.id] ? (
                      <span className="tabular-nums text-muted">
                        样本 {samples[c.id].n}/{samples[c.id].target} · 冠军 {samples[c.id].champN}/{samples[c.id].target}
                      </span>
                    ) : null}
                    {c.note ? <span className="w-full text-[11px] text-muted">{c.note}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <StateBlock kind="empty" title="还没有挑战者" hint="点上面的「让 AI 提名挑战者」，或手工编辑 data/challengers.json（README 有模板）。" />
          )}
          <p className="mt-2 text-[11px] text-muted">
            当前 {runningCount} 个在跑 · <Link to="/strategies/positions" className="hover:text-fg hover:underline">去策略追踪看持仓明细 →</Link>
          </p>
        </div>
      </Section>
      <p className="px-1 text-[11px] text-muted">
        AI 接口配置、Token 用量与自动进化开关在「<Link to="/ai" className="text-brand-text underline-offset-2 hover:underline">接入 AI</Link>」页。
      </p>
    </div>
  );
}
