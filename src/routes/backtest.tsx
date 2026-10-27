/**
 * 这个文件是干什么的：
 * 「回测」页——把跑过的回测结果摊成能比的表（对标 Vibe-Research 的 backtest 页面化）。
 *
 * 原来回测结果只 print 到 stdout，要存就人工把输出复制成 `baseline-*.txt`。
 * 现在脚本顺手落一份 JSONL（`data/backtest/runs.jsonl`，一次运行一行），这一页读它。
 *
 * 你需要知道的（纪律）：
 * 1. **两次运行的数字能不能比，取决于口径一样不一样**。成本口径改过一次
 *    （0.102% → 0.302%），旧数字全部失效。所以页面不画「历史曲线」误导人，
 *    而是把口径摊开；和当前选中那次口径不同的运行，明确标「不可比」并说差在哪。
 * 2. **|t| < 2 的超额等于没测出来**。这类策略单独列出来，不许和测出来的混排。
 * 3. 页面只展示回测跑出来的数字，**不给买卖建议**，也不预测。
 * 4. 回测本身的局限照抄不改：抽样外推要谨慎、单笔等权不是复利、样本有幸存者偏差、
 *    市值过滤用的是今天的快照不是历史。这些写在页面上，别让人忘。
 */

import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { RUNS_PATH, type BacktestRun } from "@/lib/market/backtest-runs";
import { getBacktestRuns } from "@/lib/market/quotes.functions";
import { envDiff, runSummary, styleRows, untested, type SortKey } from "@/lib/market/backtest-view";
import { auditRun, type AuditFinding } from "@/lib/market/strategy-audit";
import { barsToShow, buildCurve, curveSummary, monthlyBars, yearlyBars } from "@/lib/market/backtest-curve";
import { bootstrapSharpeCI, kurtosisOf, psr, sharpe, skewness, walkForward } from "@/lib/market/robustness";
import { AreaChart, BarChart, LineChart } from "@/components/backtest-charts";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/backtest")({
  validateSearch: (search: Record<string, unknown>) => ({
    run: typeof search.run === "string" && /^\d{4}-\d{2}-\d{2}T/.test(search.run) ? search.run : "",
  }),
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ deps }) => {
    const { runs, bad } = await getBacktestRuns();
    const picked = runs.find((r) => r.ranAt === deps.run) ?? runs[0] ?? null;
    return { runs, bad, picked, badRows: bad };
  },
  component: BacktestPage,
});

const SORT_LABEL: Record<SortKey, string> = { alpha: "超额", tStat: "t 值", trades: "笔数", winRate: "胜率" };

/** 审计发现的级别标签：和持仓页组合体检同一套色（warn/brand/muted）。 */
function AuditLevelTag({ level }: { level: AuditFinding["level"] }) {
  const map = { ok: { tone: "muted" as const, label: "正常" }, info: { tone: "brand" as const, label: "留意" }, warn: { tone: "warn" as const, label: "注意" } };
  const item = map[level];
  return <Tag tone={item.tone}>{item.label}</Tag>;
}

function BacktestPage() {
  const { runs, picked, bad } = Route.useLoaderData();
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>("alpha");

  const rows = useMemo(() => (picked ? styleRows(picked, sort) : []), [picked, sort]);
  // 策略审计（学 VT 自查）：对选中那次运行跑横切检查——共线/覆盖/样本/回撤/撮合口径。
  //
  // ⚠️ **这个 useMemo 必须在早退分支之前**（2026-10-23 修）：原来它写在
  // `if (!picked) return ...` 后面，违反了 Hook 调用顺序——picked 从 null
  // 变成有值时渲染的 Hook 数量变了，React 直接抛「Rendered fewer hooks
  // than expected」白屏。eslint 的 rules-of-hooks 能提前抓到，别关它。
  const auditFindings = useMemo(() => (picked ? auditRun(picked) : null), [picked]);

  if (!picked) {
    return (
      <Frame wide
        aside="回测"
        status={{
          label: "记录",
          value: runs.length > 0 ? `${runs.length} 次` : null,
          tone: "neutral",
        }}
      >
        <Panel title="回测" note="还没有运行记录">
          <StateBlock
            kind="empty"
            title="还没有回测记录"
            hint={`跑一次回测就会落一份记录到 ${RUNS_PATH}（脚本自动追加）。命令：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts。样本少于 50 只会被闸口拦下来，那次不会落记录。`}
          />
          {bad > 0 ? <GapList items={[`${RUNS_PATH} 有 ${bad} 行读不出来（某次运行崩了会这样），已跳过`]} /> : null}
        </Panel>
      </Frame>
    );
  }

  const weak = untested(picked);

  return (
    <Frame wide
      aside="回测"
      status={{
        label: "记录",
        value: runs.length > 0 ? `${runs.length} 次` : null,
        tone: "neutral",
      }}
      ornamentContent={
        // **真实数据**：选中那次运行里超额最高的一套策略。
        // rows 已经按当前排序排好了，rows[0] 就是当前排序下的第一。
        rows.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            {rows[0]!.label} 超额 {rows[0]!.alpha >= 0 ? "+" : ""}
            {(rows[0]!.alpha * 100).toFixed(2)}% · t {rows[0]!.tStat.toFixed(2)}
          </span>
        ) : (
          <span className="text-[11px]">这次运行没有可排的策略</span>
        )
      }
    >
      <Panel title="回测运行" note={`${runs.length} 次记录 · 新的在前`}>
        <table className="data-table w-full">
          <caption className="sr-only">回测运行历史：日期、口径摘要、与当前选中运行的可比性</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>跑的日子</th>
              <th className={thClass("text-left")}>这次跑的是什么</th>
              <th className={thClass("text-left")}>口径</th>
              <th className={thClass("text-left")}>可比性</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const s = runSummary(run);
              const diff = envDiff(picked.env, run.env);
              const same = diff.length === 0;
              return (
                <tr
                  key={run.ranAt}
                  onClick={() => void navigate({ to: "/backtest", search: { run: run.ranAt } })}
                  className={"cursor-pointer border-b border-line/60 transition hover:bg-brand-soft/20 " + (run.ranAt === picked.ranAt ? "bg-brand-soft/30" : "")}
                >
                  <td className={tdClass("text-left whitespace-nowrap")}>
                    {s.ranDate}
                    {run.ranAt === picked.ranAt ? <Tag tone="brand">当前</Tag> : null}
                  </td>
                  <td className={tdClass("text-left text-muted")}>{s.text}</td>
                  <td className={tdClass("text-left text-muted")}>{s.envText}</td>
                  <td className={tdClass("text-left")}>
                    {run.ranAt === picked.ranAt ? (
                      <span className="text-muted">—</span>
                    ) : same ? (
                      <Tag tone="muted">口径相同</Tag>
                    ) : (
                      <span className="text-[11px] text-muted" title={diff.join("；")}>
                        不可比：{diff[0]}
                        {diff.length > 1 ? ` 等 ${diff.length} 处` : ""}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {bad > 0 ? <GapList items={[`${RUNS_PATH} 有 ${bad} 行读不出来（某次运行崩了会这样），已跳过`]}/> : null}
      </Panel>

      <Panel
        title="策略审计"
        note={<span>学 VT 的 AI 自查 · 全确定性规则，对选中那次运行横切检查</span>}
        bodyClassName="px-3.5 py-3"
      >
        <ul className="flex flex-col gap-1.5">
          {/* 这里过了早退分支，picked 一定非空，auditFindings 也必然有值 */}
          {(auditFindings ?? []).map((finding: AuditFinding) => (
            <li key={`${finding.area}-${finding.title}`} className="flex items-baseline gap-2 text-xs">
              <Tag tone="muted">{finding.area}</Tag>
              <AuditLevelTag level={finding.level} />
              <span className="shrink-0 font-medium">{finding.title}</span>
              <span className="text-muted">{finding.detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
          过拟合的量化（PBO、参数敏感度）在「策略追踪 → 体检」的挑战者面板里。审计只摆事实，阈值可在 strategy-audit.ts 调。
        </p>
      </Panel>

      <Panel
        title={`${picked.ranDate} 那次运行`}
        note={`${picked.env.start} ~ ${picked.env.end}（${picked.env.days} 个交易日）· 样本 ${picked.env.covered} 只 · 换手闸${picked.env.turnoverGate ? "开" : "关"}`}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={
                "rounded border px-2 py-1 text-xs transition " +
                (sort === key ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
              }
            >
              按{SORT_LABEL[key]}排
            </button>
          ))}
          <span className="text-[11px] text-muted">按 t 值排时，|t| &lt; 2 的会沉底——那个超额和 0 分不开。</span>
        </div>

        <table className="data-table w-full">
          <caption className="sr-only">{picked.ranDate} 那次回测各策略的指标</caption>
          <thead>
            <tr className="border-b border-line">
              <th className={thClass("text-left")}>策略</th>
              <th className={thClass()}>笔数</th>
              <th className={thClass()}>胜率</th>
              <th className={thClass()}>平均收益</th>
              <th className={thClass()}>同期全池</th>
              <th className={thClass()}>超额</th>
              <th className={thClass()}>t 值</th>
              <th className={thClass()}>跑赢</th>
              <th className={thClass()}>平均持有</th>
              <th className={thClass()}>最长连亏</th>
              <th className={thClass()}>回撤</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.key} className="border-b border-line/60">
                <td className={tdClass("text-left")}>
                  <span className="text-fg">{s.label}</span>
                  {Math.abs(s.tStat) < 2 ? <span className="ml-1.5 text-[11px] text-muted">没测出来</span> : null}
                </td>
                <td className={tdClass()}>{s.trades}</td>
                <td className={tdClass()}>{`${(s.winRate * 100).toFixed(0)}%`}</td>
                <td className={tdClass("text-right " + toneClass(s.avgRet))}>{`${(s.avgRet * 100).toFixed(2)}%`}</td>
                <td className={tdClass("text-right text-muted")}>{`${(s.benchAvg * 100).toFixed(2)}%`}</td>
                <td className={tdClass("text-right " + toneClass(s.alpha))}>{`${(s.alpha * 100).toFixed(2)}%`}</td>
                <td className={tdClass("text-right " + toneClass(Math.abs(s.tStat) >= 2 ? s.tStat : null))}>{s.tStat.toFixed(2)}</td>
                <td className={tdClass("text-right text-muted")}>{`${(s.beatRate * 100).toFixed(0)}%`}</td>
                <td className={tdClass("text-right text-muted")}>{`${s.avgHold.toFixed(1)} 天`}</td>
                <td className={tdClass("text-right text-muted")}>{`${s.worstStreak} 天`}</td>
                <td className={tdClass("text-right text-muted")}>{`${(s.drawdown * 100).toFixed(1)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <BacktestCharts picked={picked} />

        {weak.length > 0 ? (
          <div className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
            测不出超额（|t| &lt; 2）的有 {weak.length} 套：
            {weak.map((s) => s.label).join("、")}。
            它们的超额和 0 分不开，写成「有效」就是自欺——要看它们，得等样本更多或换口径重跑。
          </div>
        ) : null}

        <div className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
          回测本身的局限（照抄脚本里的原文，别当优点）：单笔收益率等权累加、不是复利；样本含幸存者偏差；
          市值过滤用的是今天的快照不是历史；抽样结论外推到全市场要谨慎；回测是限价单口径，与线上现价口径有差。
          这一页只展示跑出来的数字，不给买卖建议，也不预测。
        </div>
      </Panel>
    </Frame>
  );
}
/**
 * 四张图：累计收益 / 回撤 / 月度 / 年度。
 *
 * 算法抄 Vibe-Research 的 event_study.py（cumsum 累计 + 逐列平均 + 「少于 8 次
 * 不给平均」的纪律），但**赤轨的口径三处不一样**，页面必须标清：
 * 1. 等权累加不是复利——账本不记仓位大小，每笔当等权，曲线是 Σ(ret) 不是 ∏(1+ret)。
 *    不标这一条，读者会把 30% 读成"净值涨三成"。
 * 2. 基准（同期全池）不是可投资序列，所以默认显示累计收益，过剩要切。
 * 3. 成交日不够的月份不画，并说清挡了哪几个月。
 */
function BacktestCharts({ picked }: { picked: BacktestRun }) {
  const [metric, setMetric] = useState<"ret" | "alpha">("ret");
  // 默认看第一套策略（中期反转），它有最多的成交日
  const withDaily = picked.styles.filter((s) => (s.daily?.length ?? 0) > 0);
  const [key, setKey] = useState<string>(withDaily[0]?.key ?? "");
  const row = withDaily.find((s) => s.key === key) ?? withDaily[0];

  if (!row || !row.daily) {
    return (
      <Panel title="曲线" note="这次运行没落日度序列">
        <p className="px-3.5 py-3 text-sm text-muted">
          这次运行是<strong>改动之前</strong>跑的，没存日度序列，画不出曲线。重跑一次回测就有了
          （<code className="text-[11px]">node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts</code>）。
          老记录照样能看上面的指标表——只是没图。
        </p>
      </Panel>
    );
  }

  const curve = buildCurve(row.daily, row.bench ?? []);
  const monthly = monthlyBars(row.daily);
  const yearly = yearlyBars(row.daily);
  const summary = curveSummary(curve, monthly);
  const { show, hidden } = barsToShow(monthly);

  const cum = metric === "ret" ? curve.cum : curve.cum.map((v, i) => round6(v - curve.cumBench[i]!));
  const bench = metric === "ret" ? [] : curve.cumBench;

  return (
    <Panel
      title="曲线"
      note={`${row.label} · ${row.daily.length} 个成交日 · 等权累加不是复利`}
    >
      {withDaily.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          {withDaily.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setKey(s.key)}
              className={
                "rounded border px-2 py-1 text-xs transition " +
                (s.key === row.key ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        {(["ret", "alpha"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMetric(m)}
            className={
              "rounded border px-2 py-1 text-xs transition " +
              (metric === m ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
            }
          >
            {m === "ret" ? "累计收益" : "累计超额（扣同期全池）"}
          </button>
        ))}
        {summary ? (
          <span className="text-[11px] text-muted">
            总累计 {(summary.total * 100).toFixed(2)}% · 最大回落 {(summary.maxDd * 100).toFixed(1)} 个百分点 · 胜出月份 {summary.winMonths}/{summary.months}
          </span>
        ) : null}
      </div>

      <div className="px-3.5 py-2 text-[11px] text-muted">
        纵轴是<strong>按天等权</strong>的收益率累加，不是复利净值，也<strong>不是上面表格那个「平均收益」</strong>——
        表格是每笔等权（一笔一个样本，统计口径），曲线是每天等权（一天全部平仓算一份，组合口径）。
        持仓期重叠时两者会明显分叉：某天集中平仓 50 笔，笔平均只占 50/N，日平均占 1/N 天。
        两个数都是真的，别拿一个去核对另一个。要看过剩，切到「累计超额」：那条扣掉了同期全池，
        但基准不是可投资的序列，只是"同一时间随便买一只的平均结果"。
      </div>

      <div className="border-b border-line px-3.5 pb-2">
        <LineChart dates={curve.dates} series={[{ name: metric === "ret" ? "累计收益" : "累计超额", data: cum }]} bench={bench} />
      </div>

      <div className="border-b border-line px-3.5 pb-2">
        <p className="py-1 text-xs text-muted">
          回落（从累计高点算，<strong>百分点</strong>不是比例——等权累加没有"净值"概念。和上面表格里那个回撤不是同一个口径，那个是复利净值口径）
        </p>
        <AreaChart dates={curve.dates} data={curve.dd} />
      </div>

      <div className="grid gap-3 border-b border-line px-3.5 py-2 sm:grid-cols-2">
        <div>
          <p className="py-1 text-xs text-muted">按月度（该月成交日的等权平均）</p>
          <BarChart labels={show.map((b) => b.key)} data={show.map((b) => b.ret)} />
          {hidden.length > 0 ? (
            <p className="py-1 text-[11px] text-muted">
              {hidden.length} 个月没画：{hidden.join("、")}——成交日不够 3 天，几次的平均不是平均。
            </p>
          ) : null}
        </div>
        <div>
          <p className="py-1 text-xs text-muted">按年度（口径同月度）</p>
          <BarChart labels={yearly.map((b) => b.key)} data={yearly.map((b) => b.ret)} />
        </div>
      </div>

      <RobustnessBlock daily={row.daily} />
    </Panel>
  );
}

/**
 * 稳健性面板（算法移植自 Vibe-Trading v0.1.16，MIT）：
 * 回答「这套的好成绩是不是只靠某一段行情 / 运气好」——
 *   - Walk-Forward：日度序列切 5 段，看几段赚钱（一致性），赚钱靠的是全程还是一段暴走
 *   - Bootstrap 夏普 CI：日收益有放回重采样 1000 次，给夏普的 95% 置信区间
 *   - PSR：考虑偏度/峰度后「真夏普 > 0」的概率（负偏厚尾会让同样的夏普更不可信）
 * 只展示不动判决：6 关判决和挑战者 Welch 的规则一条没改。
 */
function RobustnessBlock({ daily }: { daily: { date: string; ret: number }[] }) {
  const wf = useMemo(() => walkForward(daily, 5), [daily]);
  const boot = useMemo(() => bootstrapSharpeCI(daily.map((d) => d.ret), { draws: 1000, seed: 42 }), [daily]);
  const psrValue = useMemo(() => {
    const rets = daily.map((d) => d.ret);
    if (rets.length < 20) return null;
    try {
      // per-period（日频）夏普喂给 PSR，年化会在 PSR 内部被样本量错误放大
      return psr(sharpe(rets, 1), rets.length, 0, skewness(rets), kurtosisOf(rets));
    } catch {
      return null;
    }
  }, [daily]);

  return (
    <div className="px-3.5 py-2 text-[11px] text-muted">
      <p className="py-1 text-xs text-fg">稳健性（Vibe-Trading 同款算法，只展示不改判决）</p>
      {"error" in wf ? (
        <p className="py-1">Walk-Forward 切不了段：{wf.error}</p>
      ) : (
        <p className="py-1">
          Walk-Forward 5 段：盈利 {wf.profitableWindows}/5 段（一致性 {(wf.consistencyRate * 100).toFixed(0)}%）
          ｜各段{" "}
          {wf.windows.map((w) => `${w.start.slice(5)}~${w.end.slice(5)}:${(w.ret * 100).toFixed(1)}%`).join("、")}
          {" "}｜段间收益标准差 {(wf.retStd * 100).toFixed(2)} 个百分点——靠一段暴走的策略这个数字会很大。
        </p>
      )}
      {"error" in boot ? (
        <p className="py-1">Bootstrap：{boot.error}</p>
      ) : (
        <p className="py-1">
          Bootstrap 夏普（年化、等权口径）：观察值 {boot.observedSharpe.toFixed(2)}，95% 置信区间 [
          {boot.ciLow.toFixed(2)}, {boot.ciHigh.toFixed(2)}]，P(夏普&gt;0) = {(boot.probPositive * 100).toFixed(0)}%
          ——区间跨 0 说明这点样本说不清好坏。
        </p>
      )}
      {psrValue !== null ? (
        <p className="py-1">
          PSR（把偏度 {skewness(daily.map((d) => d.ret)).toFixed(2)}、峰度{" "}
          {kurtosisOf(daily.map((d) => d.ret)).toFixed(1)} 算进去，「真夏普&gt;0」的概率）=
          {(psrValue * 100).toFixed(0)}%。
        </p>
      ) : null}
      <p className="py-1">
        口径提醒：这里用的是<strong>按天等权累加</strong>的日收益（和上面曲线同口径），夏普是日频年化，
        和复利净值口径的夏普数字不能直接比；抽样 300 只的结论外推到全市场要谨慎。
      </p>
    </div>
  );
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
