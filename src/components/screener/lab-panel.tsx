/**
 * 这个文件是干什么的：
 * 首屏顶上的「策略实验台」——回答一个别处都不回答的问题：
 * 这套自动规则现在到底能不能下结论，还差什么。
 *
 * 你需要知道的（设计上的取舍，别当 bug 改回去）：
 *
 * 1. **结论不是「赚了多少」，是「能不能说」。** 别的地方（持仓页）给盈亏数字，
 *    这里给的是样本够不够。样本不够就明写「还不能说」，不编一个漂亮数字。
 *
 * 2. **在拿的那 60 来笔是空心的，不是灰的。** 空心 = 还没走到终点 = 没有答案。
 *    只有已卖出、结算过的那几笔才着色（红赚绿亏）。把还没卖出的涂成灰，
 *    会被读成「亏了」，那是在撒谎。
 *
 * 3. **样本墙和持仓页会对不上账，所以要专门写一行。** 收盘后补记的那一天
 *    按口径整日不进样本（positions 页也这么干），而那里面可能已经有卖出结算的。
 *    不写这行，用户看到这里 0 笔已结、持仓页却摆着 11 笔盈亏，会以为哪边算错了。
 *
 * 颜色走 tokens（text-up 红涨 / text-down 绿跌 / text-warn 警示），
 * 不要在组件里写死色值——深浅两套主题要对得上。
 */

import { Panel, pctClass } from "@/components/terminal";
import { signedPct } from "@/lib/market/format";
import type { LabReport } from "@/lib/market/lab";

/** 把 0~1 的收益率收成带正负号的百分数，例如 +3.2%。 */
function retPct(n: number | null): string {
  return n == null ? "—" : signedPct(n * 100, 1);
}

/** 实验台结论区。门槛被关掉（minClosed<=0）时整块不显示。 */
export function LabPanel({ report }: { report: LabReport }) {
  if (report.goal <= 0) return null;

  const win = report.cells.filter((cell) => cell.ret != null && cell.ret > 0).length;
  const loss = report.cells.filter((cell) => cell.ret != null && cell.ret <= 0).length;
  const benchmarkLabel = report.benchmark.available
    ? "可比"
    : report.benchmark.missingDays > 0
      ? "拿不到"
      : "—";

  return (
    <Panel title="策略实验台" className="mb-4" bodyClassName="px-4 py-6 sm:px-8 sm:py-8">
      {/*
        结论区。这一块的排法来自 design/app.html：巨号结论 + 留白 + 三个缺口数字。
        字号用 clamp 而不是写死——窄屏（375）会自己收到 32px，不会把「还不能说」
        挤成两行。真实首屏下面还有精选表，所以上限压到 52px，比 app.html 的 68px
        矮一档：原型里它独占一屏，产品里不能。
      */}
      <div className="border-b border-line pb-6">
        <div className="text-xs tracking-wide text-muted">这套自动规则现在能下结论吗</div>
        <p
          className={`mt-3 font-medium leading-none tracking-tight ${
            report.canSay ? "text-fg" : "text-warn"
          }`}
          style={{ fontSize: "clamp(32px, 5vw, 52px)" }}
        >
          {report.canSay ? "能下结论了" : "还不能说"}
        </p>
        <p className="mt-4 max-w-[56ch] text-xs leading-relaxed text-muted">
          样本不够不等于成绩不好——现在是<b className="font-normal text-fg">还没有成绩</b>，不是成绩差。
          {report.reason ? ` ${report.reason}。` : ""}
        </p>

        <div className="mt-7 flex flex-wrap gap-x-8 gap-y-5">
          <div>
            <div className="text-xs text-muted">能对比指数的已结样本</div>
            <div className="mt-1 text-2xl font-medium tabular-nums text-fg">
              {report.closed}
              <span className="text-sm font-normal text-muted"> / {report.goal}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted">门槛来自 rules.minClosed</div>
          </div>
          <div>
            <div className="text-xs text-muted">还差</div>
            <div className="mt-1 text-2xl font-medium tabular-nums text-fg">
              {report.needMore}
              <span className="text-sm font-normal text-muted"> 笔</span>
            </div>
            <div className="mt-1 text-[11px] text-muted">中期反转拿满 10 个交易日出结果</div>
          </div>
          <div>
            <div className="text-xs text-muted">同期沪深300</div>
            <div
              className={`mt-1 text-2xl font-medium tabular-nums ${
                report.benchmark.available ? "text-fg" : "text-warn"
              }`}
            >
              {benchmarkLabel}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              {report.benchmark.available ? "可以算有没有跑赢" : "账本没存 indexExit，从记录那天就缺"}
            </div>
          </div>
        </div>

        <div
          className="mt-7 h-1.5 w-full max-w-xl overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={Math.round(report.progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="样本积累进度"
        >
          <div className="h-full rounded-full bg-warn" style={{ width: `${report.progress}%` }} />
        </div>
      </div>

      {/* 样本墙 */}
      <div className="pt-6">
        <div className="mb-2 text-xs text-muted">
          全部样本 {report.total} 笔：已结 {report.closed} 格着色，在拿 {report.open} 格空心
        </div>
        <div
          className="flex flex-wrap gap-[3px]"
          role="img"
          aria-label={`${report.total} 笔样本：${report.open} 笔还没卖出，${report.closed} 笔已卖出（盈利红、亏损绿）`}
        >
          {report.cells.map((cell, i) => {
            if (cell.ret == null) {
              return <i key={i} aria-hidden className="inline-block size-3.5 border border-line" />;
            }
            const up = cell.ret > 0;
            return (
              <i
                key={i}
                aria-hidden
                className={`inline-block size-3.5 ${up ? "bg-up" : "bg-down"}`}
                title={`${cell.name} ${retPct(cell.ret)}`}
              />
            );
          })}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            <i aria-hidden className="mr-1 inline-block size-2.5 border border-line align-[-1px]" />
            在拿 {report.open} 笔 · 还没有答案
          </span>
          {loss > 0 ? (
            <span>
              <i aria-hidden className="mr-1 inline-block size-2.5 bg-down align-[-1px]" />
              卖出亏损 {loss} 笔
            </span>
          ) : null}
          {win > 0 ? (
            <span>
              <i aria-hidden className="mr-1 inline-block size-2.5 bg-up align-[-1px]" />
              卖出盈利 {win} 笔
            </span>
          ) : null}
        </div>
      </div>

      {/* 被口径排掉的那部分，明说，别让样本凭空少一截 */}
      {report.skipped.trades > 0 ? (
        <p className="pt-4 text-xs text-muted">
          另有 {report.skipped.days} 个交易日（{report.skipped.trades} 笔）是收盘后补记的，
          按口径不进样本——持仓页仍会显示它们已实现的盈亏。
        </p>
      ) : null}

      {/* 按策略拆 */}
      <div className="mt-5 grid gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-2">
        {report.byStyle.map((row) => (
          <div key={row.style} className="bg-surface px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-fg">
                {row.name}
                <span className="ml-1.5 text-xs text-muted">{row.total} 笔</span>
              </span>
              <span className={`text-sm tabular-nums ${row.avg == null ? "text-muted" : pctClass(row.avg * 100)}`}>
                {retPct(row.avg)}
              </span>
            </div>
            <div className="mt-1 flex gap-4 text-xs text-muted">
              <span>
                已结 <span className="tabular-nums text-fg">{row.closed}</span>
              </span>
              <span>
                盈利 <span className="tabular-nums text-fg">{row.win ?? "—"}</span>
              </span>
              <span>
                离 {row.goal} 还差 <span className="tabular-nums text-fg">{row.needMore}</span>
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-warn"
                style={{ width: `${Math.min(100, (row.closed / row.goal) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
