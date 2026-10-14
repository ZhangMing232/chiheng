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
import { loadBacktestRuns, RUNS_PATH } from "@/lib/market/backtest-runs";
import { envDiff, runSummary, styleRows, untested, type SortKey } from "@/lib/market/backtest-view";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/backtest")({
  validateSearch: (search: Record<string, unknown>) => ({
    run: typeof search.run === "string" && /^\d{4}-\d{2}-\d{2}T/.test(search.run) ? search.run : "",
  }),
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ deps }) => {
    const { runs, bad } = await loadBacktestRuns();
    const picked = runs.find((r) => r.ranAt === deps.run) ?? runs[0] ?? null;
    return { runs, bad, picked, badRows: bad };
  },
  component: BacktestPage,
});

const SORT_LABEL: Record<SortKey, string> = { alpha: "超额", tStat: "t 值", trades: "笔数", winRate: "胜率" };

function BacktestPage() {
  const { runs, picked, bad } = Route.useLoaderData();
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>("alpha");

  const rows = useMemo(() => (picked ? styleRows(picked, sort) : []), [picked, sort]);

  if (!picked) {
    return (
      <Frame aside="回测">
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
    <Frame aside="回测">
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