/**
 * 这个文件是干什么的：
 * 「因子」页。把这一轮因子挖掘摆出来：25 个因子的 6 关判决、分档形状、
 * 缩量天数归因、资金流探路，以及回测基线原文。
 *
 * 你需要知道的：
 * 1. **数字全部从 data/backtest/ 下的产物算出来**，页面文案里不写第二份数字。
 *    重跑一次回测，页面自己会变——这是这个页面存在的意义，硬编码就废了。
 * 2. **data/ 在 .gitignore 里**，线上和新机器必然读不到。三份数据各自降级：
 *    读不到就显示 StateBlock 并给出能复制的重跑命令，绝不显示「0 个因子」——
 *    那是把「没跑过」说成「跑过了但没过关」，两件事差很远。
 * 3. 未过关的因子一个都不藏。现在就是「25 个里 0 个全过」，这个数字要放大了给人看。
 * 4. 长口径说明放在区块标题**正下方**（Section 的 hint），不用 Panel——
 *    Panel 的 note 在右上角，这一页每块都要交代口径，塞右边读不顺（资金页同一个取舍）。
 */
import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Stat, Table, tdClass, thClass, pctClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { signedPct } from "@/lib/market/format";
import {
  getAIStatus,
  getFactorBaseline,
  getFactorDiag,
  getFactorQueue,
  getFactorRuns,
  runFactorAI,
  saveAIConfig,
} from "@/lib/market/quotes.functions";
import { batchSummary, factorRows, flowStress } from "@/lib/market/factors-view";
import { FactorGateTable, BucketShape } from "@/components/screener/factor-gate-table";
import { FlowProbePanel, ShrinkFlipPanel } from "@/components/screener/factor-diag-panels";
import type {
  FactorBaselinePayload,
  FactorDiagPayload,
  FactorRunsPayload,
} from "@/lib/market/factor-runs-file";
import type { QueueEntry, QueuePayload } from "@/lib/market/factor-queue";

/** loader 里 catch 用的兜底。不 import factor-runs-file 里的 empty* —— 那个模块有 node:fs，
 *  被前端打进来会炸。类型可以 import（编译期擦除），值不行。 */
type Loader = {
  runs: FactorRunsPayload;
  diag: FactorDiagPayload;
  baseline: FactorBaselinePayload;
  queue: QueuePayload;
  ai: { allowed: boolean; configured: boolean; baseUrl: string | null; model: string | null; keyTail: string | null };
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RERUN_HINT =
  "在项目根目录跑：BT_FACTOR=1 BT_N=10 node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts";

export const Route = createFileRoute("/factors")({
  loader: async (): Promise<Loader> => {
    // 三份各自独立失败：某一块读不到就那一块空着，其余照常渲染。
    const [runs, diag, baseline, queue, ai] = await Promise.all([
      getFactorRuns().catch(
        (e: unknown): FactorRunsPayload => ({
          batch: null,
          batches: [],
          badLines: 0,
          missing: messageOf(e),
        }),
      ),
      getFactorDiag().catch(
        (e: unknown): FactorDiagPayload => ({
          shrinkFlip: null,
          shrinkBull: null,
          flowProbe: [],
          badLines: 0,
          missing: messageOf(e),
        }),
      ),
      getFactorBaseline().catch(
        (e: unknown): FactorBaselinePayload => ({ name: null, text: null, bytes: 0, missing: messageOf(e) }),
      ),
      getFactorQueue().catch(
        (e: unknown): QueuePayload => ({ entries: [], missing: messageOf(e) }),
      ),
      getAIStatus().catch(
        (): Loader["ai"] => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null }),
      ),
    ]);
    return { runs, diag, baseline, queue, ai };
  },
  component: FactorsPage,
});

const TABS = [
  { id: "factor-verdict", label: "结论" },
  { id: "factor-gates", label: "6 关判决" },
  { id: "factor-buckets", label: "分档明细" },
  { id: "factor-attrib", label: "缩量归因" },
  { id: "factor-flow", label: "资金流探路" },
  { id: "factor-baseline", label: "基线原文" },
  { id: "factor-ai", label: "AI 管理" },
] as const;

const QUEUE_STATUS: Record<QueueEntry["status"], { label: string; className: string }> = {
  pending: { label: "待验", className: "text-fg" },
  tested: { label: "在验·未过", className: "text-warn" },
  passed: { label: "已过 6 关", className: "text-up" },
  tombstone: { label: "已淘汰", className: "text-muted line-through" },
};

/**
 * AI 因子管理区块：接口配置（主人可见，key 只回尾号）、跑一轮闭环、待验队列表。
 * AI 的产出进队列前要经过白名单编译 + 撞名校验——它提议，闸门说了算。
 */
function AIFactorSection({ queue, ai }: { queue: QueuePayload; ai: Loader["ai"] }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const save = async () => {
    try {
      const res = await saveAIConfig({ data: { baseUrl, apiKey, model } });
      setMessage(
        res.configured ? `已保存 ${res.baseUrl} · ${res.model} · key 尾号 ${res.keyTail ?? ""}`.trim() : "已清除 AI 配置",
      );
      setBaseUrl("");
      setApiKey("");
      setModel("");
      await router.invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    }
  };

  const run = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const res = await runFactorAI();
      setMessage(
        res.ok
          ? `本轮提议 ${res.proposed} 个进队列` +
              (res.rejected > 0 ? `，拒了 ${res.rejected} 个（${res.rejectReasons.slice(0, 2).join("；")}${res.rejectReasons.length > 2 ? "…" : ""}）` : "") +
              "。跑一次 BT_FACTOR=1 回测就会进 6 关检验。"
          : `没跑成：${res.error ?? "未知原因"}`,
      );
      await router.invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "运行失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section
      id="factor-ai"
      title="AI 因子管理"
      hint="AI 读最近一轮 6 关判决，针对败因提 1~3 个新假设进待验队列；表达式只能组合现有指标（abs/log/sqrt），过不了白名单编译的直接拒。连续 2 次没过 6 关自动淘汰。AI 不碰判决逻辑、不碰持仓下单。"
    >
      {ai.allowed ? (
        <div className="border-b border-line px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="shrink-0 text-xs font-medium text-muted">AI 接口（OpenAI 兼容，Ollama / LM Studio 也行）</span>
            <span className="truncate text-xs text-muted">
              {ai.configured ? `已配置 · ${ai.baseUrl} · ${ai.model} · key 尾号 ${ai.keyTail}` : "未配置"}
            </span>
          </div>
          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={ai.configured ? ai.baseUrl ?? "baseUrl" : "https://api.example.com/v1"}
              className="min-w-0 rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder={ai.configured ? "填新 key 替换，留空保存可清除" : "API key"}
              className="min-w-0 rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={ai.configured ? ai.model ?? "model" : "模型名，如 qwen2.5:14b"}
              className="min-w-0 rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
            <button
              type="button"
              onClick={() => void save()}
              className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
            >
              保存
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={running || !ai.configured}
              onClick={() => void run()}
              className="shrink-0 rounded border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "AI 思考中…" : "让 AI 提议一轮新因子"}
            </button>
            {message ? <span className="min-w-0 text-xs text-muted">{message}</span> : null}
          </div>
        </div>
      ) : null}

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
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <StateBlock
            kind="empty"
            title="待验队列是空的"
            hint={ai.allowed ? "在上面配好接口，点「让 AI 提议一轮新因子」；提议进队列后跑一次 BT_FACTOR=1 回测。" : "主人账号配置 AI 接口后可以自动补充新因子。"}
          />
        )}
        {queue.missing ? <p className="mt-2 text-[11px] text-muted">{queue.missing}（还没跑过，正常）</p> : null}
      </div>
    </Section>
  );
}

/** 区块外壳。口径说明在标题正下方，不用 Panel（它的 note 在右侧）。 */
function Section({
  id,
  title,
  hint,
  children,
}: {
  id?: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded border border-line bg-surface">
      <header className="border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * 页内子页签：点一下切到对应子页面，**只渲染当前那一个**——
 * 以前七个区块全挂在 DOM 里靠滚动侦测高亮，找「基线原文」要从头滚到底。
 * 现在是真三级导航：左侧栏（1 级）→ 因子页（2 级）→ 页签（3 级）。
 */
function FactorTabs({ active, onChange }: { active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-0.5 overflow-x-auto scroll-slim">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          aria-pressed={active === tab.id}
          className={
            "nav-tab inline-flex shrink-0 items-center rounded text-sm " +
            (active === tab.id ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function FactorsPage() {
  const data = Route.useLoaderData();
  const runs = data.runs;
  const diag = data.diag;
  const baseline = data.baseline;

  const rows = useMemo(() => factorRows(runs.batch?.rows ?? []), [runs.batch]);
  const summary = useMemo(() => batchSummary(runs.batch?.rows ?? []), [runs.batch]);
  const flowGroups = useMemo(() => flowStress(diag.flowProbe), [diag.flowProbe]);

  const runAt = runs.batch?.at ? new Date(runs.batch.at).toLocaleString("zh-CN", { hour12: false }) : null;

  /** 当前子页签。只渲染选中的那一个区块——七个全挂 DOM 的老做法废掉了。 */
  const [activeTab, setActiveTab] = useState<string>(TABS[0].id);

  return (
    <Frame aside={runAt ? `因子批次 ${runAt}` : undefined}>
      <FactorTabs active={activeTab} onChange={setActiveTab} />

      {/* 1 结论 */}
      {activeTab === "factor-verdict" ? (
        <Section
        id="factor-verdict"
        title="现在能下结论吗"
        hint="数字全部从 data/backtest/ 的产物算出，重跑回测会自动更新。结论只针对「单因子」这一层，不含组合。"
      >
        {runs.batch ? (
          <div className="px-3.5 py-4">
            <div className="text-xs tracking-wide text-muted">这一轮挖出来的因子里，有几个过了全部 6 关</div>
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
      ) : null}

      {/* 2 六关判决 */}
      {activeTab === "factor-gates" ? (
      <Section
        id="factor-gates"
        title="6 关判决总表"
        hint="点因子名就地展开：五档形状 + 每关判据原话 + 跑之前写下的方向理由。t 日收盘排序，次日开盘等权买入、持有 10 天后按收盘卖出，收益减同期全池。「—」表示这一关这次没做或没记，不是没通过。"
      >
        {rows.length > 0 ? (
          <div>
            <FactorGateTable rows={rows} />
            <p className="px-3 py-2 text-[11px] leading-relaxed text-muted">
              六关判什么：G1 单调且方向符合预注册（Spearman ≥0.8）· G2 |t|≥2 · G3 前后两段同号且各 |t|≥1 ·
              G4 换一批不重叠的股票仍同号且 |t|≥2 · G5 Bonferroni 按已测总数 N 收紧临界 · G6 顶档被可交易闸挡掉 ≤50%。
            </p>
            <div className="border-t border-line px-3 py-2">
              <p className="text-[11px] font-medium text-muted">败在一关 = 得了一种病，对症下药才值得再试：</p>
              <ul className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-muted">
                <li>· G1 形状不符——五档形状和当初登记的方向对不上；要改就按真实形状换个新 id 重新预登记，旧记录留档。</li>
                <li>· G2 t 不够——|t|&lt;2 等于没测出来，大概率是噪声，别当回事。</li>
                <li>· G3 时段翻号——前半段后半段结论相反，换个行情环境就亏钱，最致命，别抱幻想。</li>
                <li>· G4 换样本死——换批股票就不成立，只是这批票的巧合。</li>
                <li>· G5 校正后不显著——测的因子多了，运气成分被 Bonferroni 挤掉，降回候选。</li>
                <li>· G6 顶档被挡——最好的那档实际买不进去，纸上富贵；闸门对应真实下单约束，不许调低。</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有可展示的判决" hint={runs.missing ?? RERUN_HINT} />
          </div>
        )}
      </Section>
      ) : null}

      {/* 3 分档明细 */}
      {activeTab === "factor-buckets" ? (
      <Section
        id="factor-buckets"
        title="分档均值明细"
        hint="每一档是这一档所有票未来 10 天收益减去同期全池等权的平均——是超额，不是收益。看形状比看单个数字重要：单调才算数。"
      >
        {rows.length > 0 ? (
          <Table className="data-table" caption="各因子五档平均超额，从因子值最低档到最高档">
            <thead>
              <tr className="border-b border-line">
                <th className={thClass("text-left")}>因子</th>
                {[1, 2, 3, 4, 5].map((i) => (
                  <th key={i} className={thClass()}>
                    档{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-b-0">
                  <td data-l="因子" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
                    <span className="font-medium">{row.name}</span>
                    <span className="ml-1.5 text-[11px] text-muted">{row.category}</span>
                  </td>
                  {row.bucketMeans.map((v, i) => (
                    <td key={i} data-l={`档${i + 1}`} className={tdClass(pctClass(v * 100))}>
                      {signedPct(v * 100)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有分档数据" hint={runs.missing ?? RERUN_HINT} />
          </div>
        )}
      </Section>
      ) : null}

      {/* 4 缩量归因 */}
      {activeTab === "factor-attrib" ? (
      <Section
        id="factor-attrib"
        title="缩量天数归因"
        hint="缩量天数是 |t| 最大、最有希望的一个，但 G3 两段翻号没过关。这一块是「为什么没过关」的解释，它本身不是过关证明。"
      >
        {diag.shrinkFlip ? (
          <ShrinkFlipPanel diag={diag.shrinkFlip} bull={diag.shrinkBull} />
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock
              kind="empty"
              title="归因诊断还没跑"
              hint={
                "在本机跑：BT_FACTOR=1 BT_N=10 BT_DIAG=shrinkDays BT_NO_LOG=1 node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts" +
                "（BT_NO_LOG=1 必须带，否则会往因子日志里多塞一批）"
              }
            />
          </div>
        )}
      </Section>
      ) : null}

      {/* 5 资金流探路 */}
      {activeTab === "factor-flow" ? (
      <Section
        id="factor-flow"
        title="资金流探路"
        hint="量价之外换了个维度再试：东财个股日级主力净流入。窗口只有 120 个交易日，G3 两段各 60 天偏短——这里的 t 只当方向，不当过关。"
      >
        {flowGroups.length > 0 ? (
          <FlowProbePanel groups={flowGroups} />
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock
              kind="empty"
              title="资金流探路还没跑"
              hint={
                "两步：先 node scripts/build-flow.mjs 拉 300 只票的资金流缓存（约 10 分钟），" +
                "再 for N in 5 10 20; do BT_FLOW=1 BT_N=$N node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts; done"
              }
            />
          </div>
        )}
      </Section>
      ) : null}

      {/* 6 基线原文 */}
      {activeTab === "factor-baseline" ? (
      <Section
        id="factor-baseline"
        title="回测基线原文"
        hint="整段原文，一字未加工。它是人工维护的结论记录，时间可能和上面最新批次对不上——以块里的数字为准。"
      >
        {baseline.text ? (
          <details className="px-3.5 py-3">
            <summary className="cursor-pointer text-xs text-muted">
              {baseline.name}（{(baseline.bytes / 1024).toFixed(1)} KB，默认收起）
            </summary>
            <pre className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {baseline.text}
            </pre>
          </details>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有基线文本" hint={baseline.missing ?? "跑一次回测后会写 baseline-*.txt"} />
          </div>
        )}
      </Section>
      ) : null}

      {/* 7 AI 管理 */}
      {activeTab === "factor-ai" ? (
        <AIFactorSection queue={data.queue} ai={data.ai} />
      ) : null}

      <p className="px-1 text-[11px] leading-relaxed text-warn">
        超额 ≠ 收益；|t| &lt; 2 等于没测出来；两段翻号 = 不能用；禁调参过关。
      </p>
    </Frame>
  );
}
