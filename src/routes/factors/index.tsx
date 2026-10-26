/**
 * 这个文件是干什么的：
 * 「因子」区的「结论」子页（/factors/）。一句话回答「这一轮挖出来的因子里
 * 有几个过了全部 6 关」，外加检验参数控件、批次选择器和因子/策略的 AI 闭环面板。
 *
 * 你需要知道的（纪律）：
 * 1. **数字全部从 data/backtest/ 下的产物算出来**，页面文案里不写第二份数字。
 *    重跑一次回测，页面自己会变——硬编码就废了。
 * 2. **data/ 在 .gitignore 里**，线上和新机器必然读不到：读不到就显示 StateBlock
 *    并给出能复制的重跑命令，绝不显示「0 个因子」——那是把「没跑过」说成「跑过了
 *    但没过关」，两件事差很远。
 * 3. 未过关的因子一个都不藏。「25 个里 0 个全过」这个数字要放大了给人看。
 * 4. 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab），批次参数走地址栏
 *    （?batch=N），刷新保持。
 */

import { useMemo, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { FactorLoopPanels } from "@/components/screener/factor-loop-panels";
import { Stat, Panel, Tag, Prog } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { SourceLine } from "@/components/source-line";
import { signedPct } from "@/lib/market/format";
import { getFactorRuns, getTombstones, runFactorTest } from "@/lib/market/quotes.functions";
import { PARAM_BOUNDS } from "@/lib/market/factor-test-runner";
import { batchSummary, type BatchSummary } from "@/lib/market/factors-view";
import type { FactorRunsPayload } from "@/lib/market/factor-runs-file";
import type { TombstoneRecord } from "@/lib/market/factor-tombstones";
import {
  BatchPicker,
  FactorSectionTabs,
  messageOf,
  parseBatch,
  RERUN_HINT,
  Section,
} from "@/components/factor-sections";

export const Route = createFileRoute("/factors/")({
  validateSearch: (search: Record<string, unknown>) => ({ batch: parseBatch(search) }),
  loaderDeps: ({ search }) => ({ batch: search.batch }),
  loader: async ({ deps }) => {
    const [runs, tombstones] = await Promise.all([
      getFactorRuns({ data: { batch: deps.batch } }).catch(
        (e: unknown): FactorRunsPayload => ({
          batch: null,
          batches: [],
          batchIndex: -1,
          badLines: 0,
          missing: messageOf(e),
        }),
      ),
      getTombstones().catch((): TombstoneRecord[] => []),
    ]);
    return { runs, tombstones };
  },
  component: FactorsIndexPage,
});

/**
 * 检验参数控件：持有天数 / 分档数 / 样本只数 / 换样本起点，四个采样参数
 * 选完一键重跑。可调范围在 PARAM_BOUNDS（factor-test-runner.ts）一处登记，
 * 控件选项和校验边界同源——界面上造不出范围外的参数。
 * 注意：能调的只有采样参数；因子注册表和 6 关判据在代码里预登记，这里碰不到。
 */
function TestControls({ defaults }: { defaults: { n: number; buckets: number } }) {
  const router = useRouter();
  const [n, setN] = useState(defaults.n);
  const [buckets, setBuckets] = useState(defaults.buckets);
  const [sample, setSample] = useState(300);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const selectCls = "rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-brand";

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await runFactorTest({ data: { n, buckets, sample, offset } });
      setMsg(res.ok ? `跑完了（${Math.round(res.ms / 1000)}s），最新批次已更新` : `回测退出码非 0：\n${res.tail}`);
      if (res.ok) await router.invalidate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-line bg-surface px-3 py-2 text-xs">
      <span className="font-medium">检验参数</span>
      <label className="flex items-center gap-1 text-muted">
        持有
        <select value={n} onChange={(e) => setN(Number(e.target.value))} className={selectCls}>
          {PARAM_BOUNDS.n.options.map((o) => (
            <option key={o} value={o}>{o} 天</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted">
        分
        <select value={buckets} onChange={(e) => setBuckets(Number(e.target.value))} className={selectCls}>
          {PARAM_BOUNDS.buckets.options.map((o) => (
            <option key={o} value={o}>{o} 档</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted">
        样本
        <select value={sample} onChange={(e) => setSample(Number(e.target.value))} className={selectCls}>
          {PARAM_BOUNDS.sample.options.map((o) => (
            <option key={o} value={o}>{o} 只</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted">
        换样本
        <select value={offset} onChange={(e) => setOffset(Number(e.target.value))} className={selectCls}>
          {PARAM_BOUNDS.offset.options.map((o) => (
            <option key={o} value={o}>{o === 0 ? "原样本" : `第 ${o} 批`}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "检验运行中…（约 2-5 分钟）" : "按此参数重跑检验"}
      </button>
      {msg ? <span className="w-full whitespace-pre-wrap text-[11px] text-muted">{msg}</span> : null}
      <span className="w-full text-[11px] leading-relaxed text-muted">
        只调采样参数；6 关判据和因子注册表预登记在代码里，这里碰不到。跑完自动追加为最新一批，批次选择器里能和老批次对比。
      </span>
    </div>
  );
}

/**
 * 因子实验室速览卡：照效果图「因子实验室」三栏（门控结果 / 因子成色 / 因子墓碑）。
 * 全部接真实数据——效果图里那几条「IC 均值 / IC IR / 换手率 / 覆盖度」是草图占位，
 * 赤轨没有这些数，硬填=编假数，违反纪律；所以第二栏换成真实可算的成色指标，
 * 第三栏接真实死因档案（factor-tombstones.ts）的前 3 条。
 */
function FactorLabCard({ summary, tombstones, batchIndex }: { summary: BatchSummary; tombstones: TombstoneRecord[]; batchIndex: number }) {
  const { total, passed, strongest, nearMiss, familyClashes } = summary;
  const passRate = total > 0 ? passed / total : 0;
  const nearRate = total > 0 ? nearMiss.length / total : 0;
  const tBar = strongest ? Math.min(1, Math.abs(strongest.t) / 3) : 0;
  const headCls = "mb-2 flex items-center gap-2 border-l-2 border-brand pl-2 text-xs font-medium";
  return (
    <Panel
      title="因子实验室"
      action={<Link to="/factors/gates" search={{ batch: batchIndex }} className="text-xs text-muted transition hover:text-fg">查看 6 关明细 →</Link>}
      bodyClassName="px-3.5 py-3"
    >
      <div className="grid gap-5 sm:grid-cols-3">
        {/* ① 门控结果 */}
        <div>
          <div className={headCls}>门控结果</div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted">当前批次</span>
              <Tag tone={passed > 0 ? "up" : "warn"}>{passed > 0 ? "部分通过" : "未通过"}</Tag>
            </div>
            <div>
              <div className="flex justify-between"><span className="text-muted">通过率</span><span className="tabular-nums">{passed}/{total}</span></div>
              <Prog value={passRate} />
            </div>
            <div className="flex justify-between"><span className="text-muted">最强因子 |t|</span><span className="tabular-nums">{strongest ? strongest.t.toFixed(2) : "—"}</span></div>
            <div className="flex justify-between"><span className="text-muted">同族冲突</span><span className="tabular-nums">{familyClashes.length} 组</span></div>
          </div>
        </div>
        {/* ② 因子成色（真实指标，非 IC 占位） */}
        <div>
          <div className={headCls}>因子成色</div>
          <div className="space-y-2 text-xs">
            <div>
              <div className="flex justify-between"><span className="text-muted">全过因子</span><span className="tabular-nums">{passed} 个</span></div>
              <Prog value={passRate} />
            </div>
            <div>
              <div className="flex justify-between"><span className="text-muted">接近过关（差≤1关）</span><span className="tabular-nums">{nearMiss.length} 个</span></div>
              <Prog value={nearRate} />
            </div>
            <div>
              <div className="flex justify-between"><span className="text-muted">最强 |t| 强度</span><span className="tabular-nums">{strongest ? `${strongest.t.toFixed(2)} / 3` : "—"}</span></div>
              <Prog value={tBar} />
            </div>
          </div>
        </div>
        {/* ③ 因子墓碑（真实死因档案前 3 条） */}
        <div>
          <div className={headCls}>因子墓碑</div>
          {tombstones.length > 0 ? (
            <ul className="space-y-1.5">
              {tombstones.slice(0, 3).map((r) => (
                <li key={`${r.id}-${r.diedAt}`} className="rounded border border-line bg-surface px-2 py-1.5">
                  <div className="text-xs font-medium">{r.name}</div>
                  <div className="text-[11px] text-muted">
                    {r.diedAt.slice(0, 10)}
                    {r.failedGates.length ? ` · 败于 ${r.failedGates.join("/")}` : " · 衰退休退"}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">还没有被淘汰的因子。</p>
          )}
          <p className="mt-2 text-[11px] text-muted">完整死因档案见下方「决策者记分牌」。</p>
        </div>
      </div>
    </Panel>
  );
}

function FactorsIndexPage() {
  const { runs, tombstones } = Route.useLoaderData();

  const summary = useMemo(() => batchSummary(runs.batch?.rows ?? []), [runs.batch]);

  const runAt = runs.batch?.at ? new Date(runs.batch.at).toLocaleString("zh-CN", { hour12: false }) : null;

  return (
    <Frame
      aside={runAt ? `因子批次 ${runAt}` : undefined}
      status={{
        label: "过关",
        // **真实数据**：batchSummary.passed 是六关全过的因子数。
        // summary.total 是这批跑过的因子数。没有批次就是 null（不显示 0/0——
        // 「没跑过」和「跑了但没过」是两件事）。
        value: summary.total > 0 ? `${summary.passed} / ${summary.total}` : null,
        tone: summary.passed > 0 ? "ok" : "neutral",
      }}
      ornamentContent={
        summary.strongest ? (
          <span className="text-[11px] tabular-nums">
            最强 {summary.strongest.name} · t {summary.strongest.t.toFixed(2)}
          </span>
        ) : (
          <span className="text-[11px]">这批没有因子通过全部六关</span>
        )
      }
    >
      <h1 className="font-display text-xl font-medium tracking-wide">因子实验室</h1>
      <FactorSectionTabs />
      {runs.batch ? <FactorLabCard summary={summary} tombstones={tombstones} batchIndex={runs.batchIndex} /> : null}
      {runs.batch ? <TestControls defaults={{ n: runs.batch.n, buckets: runs.batch.buckets }} /> : null}
      <BatchPicker runs={runs} current={runs.batchIndex} to="/factors/" />

      {/* 1 结论 */}
      <Section
        title="现在能下结论吗"
        hint="数字全部从 data/backtest/ 的产物算出，重跑回测会自动更新。结论只针对「单因子」这一层，不含组合。"
      >
        {runs.batch ? (
          <div className="px-3.5 py-4">
            <div className="text-xs tracking-wide text-muted">这一轮挖出来的因子里，有几个过了全部 6 关</div>
            {/* U1 防误读声明（UI-STANDARD v1.1）：过关是「这套数据+这套判据下站得住」，
                不等于未来能赚，更不是推荐。写死在界面上，不靠用户猜。 */}
            <p className="mt-3 max-w-[56ch] text-xs leading-relaxed text-muted">
              6 关是固定判据，回答「这个规律和噪声分不分得开」，不回答「买了赚不赚钱」——
              过关因子也不构成推荐；没过也不等于这个概念死了，可能是这批数据/这段行情测不出来。
            </p>
            <p
              className={`mt-3 font-medium leading-none tracking-tight ${summary.passed > 0 ? "text-fg" : "text-warn"}`}
              style={{ fontSize: "clamp(28px, 4vw, 42px)" }}
            >
              {summary.total} 个里 {summary.passed} 个
            </p>
            <p className="mt-3 max-w-[56ch] text-xs leading-relaxed text-muted">
              0 个过关不等于挖得不用心——是这套数据、这套判据下确实没有一个站得住的单因子。
              {summary.strongest
                ? ` |t| 最大的是「${summary.strongest.name}」（${summary.strongest.t.toFixed(2)}），也只过了 ${summary.strongest.passed}/6 关。`
                : ""}
            </p>
            <div className="mt-5 grid gap-px bg-line sm:grid-cols-3">
              {summary.nearMiss.slice(0, 3).map((row) => (
                <Stat
                  key={row.id}
                  label={`最接近的：${row.name}`}
                  value={`${row.passed}/${row.total} 关`}
                  hint={`t=${row.t.toFixed(2)}，缺的那关：${
                    row.gates.find((g) => g.pass !== true)?.key.toUpperCase() ?? "—"
                  }`}
                  className="bg-surface"
                />
              ))}
            </div>
            {summary.familyClashes.length > 0 && (
              <div className="mt-4 border border-line bg-surface px-3.5 py-3">
                <div className="text-xs font-medium text-warn">
                  同族同方向 {summary.familyClashes.length} 组——「{summary.total} 个因子」的概念数要打折看
                </div>
                <ul className="mt-2 space-y-1 text-xs leading-relaxed text-muted">
                  {summary.familyClashes.map((c) => (
                    <li key={`${c.family}|${c.direction}`}>
                      「{c.family}」族：{c.members.map((m) => m.name).join("、")}（
                      {c.direction > 0 ? "同向偏多" : "同向偏空"}，算的是同一个东西的不同窗口）
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  这是注册表层的近似检查，不是收益序列相关；它回答「是不是一个概念」，真共线由 G1-G6 判。
                </p>
              </div>
            )}
            <div className="mt-4 border-t border-line px-3.5 py-2">
              <SourceLine
                at={runAt ? `${runAt}（本机时区）` : null}
                cached={false}
                origin="data/backtest/factor-runs.jsonl（本地产物，重跑回测即更新）"
              />
            </div>
          </div>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock
              kind="empty"
              title="因子判决还没跑出数据"
              hint={`本机没有 data/backtest/factor-runs.jsonl。${RERUN_HINT}。data/ 不在 git 里，换机器要重跑。`}
            />
          </div>
        )}
      </Section>

      <p className="px-1 text-[11px] leading-relaxed text-warn">
        超额 ≠ 收益；|t| &lt; 2 等于没测出来；两段翻号 = 不能用；禁调参过关。
      </p>

      {/* 因子与策略的 AI 闭环（2026-10-13 从 /ai 页搬来）：待验队列、决策者记分牌、挑战者提名 */}
      <FactorLoopPanels />
    </Frame>
  );
}
