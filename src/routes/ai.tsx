/**
 * 这个文件是干什么的：
 * 「AI 管理」二级页面（/ai）。AI 参与系统的所有入口收拢在一处：
 *接口配置（因子层和策略层共用一份）、因子待验队列、策略挑战者提名。
 * 两个层级的红线一样：AI 只许提议（表达式 / 参数旋钮），判决永远由预先
 * 登记的函数说了算——具体纪律见 factor-queue.ts 和 strategy-ai.ts 的文件头。
 *
 * 你需要知道的：
 * 1. apiKey 是密钥：服务端只回尾四位，完整值不出服务端；配置入口也只给主人账号。
 * 2. 队列和挑战者名单分别住在 data/factor-queue.json 和 data/challengers.json，
 *    data/ 在 .gitignore 里，换机器要重新跑。
 * 3. 提名进队列/进挑战者名单 ≠ 生效：因子要等 BT_FACTOR=1 回测过 6 关，
 *    挑战者要攒满 30 笔纸面样本过 Welch 判决。
 */
import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import {
  getAIStatus,
  getChallengers,
  getFactorQueue,
  runFactorAI,
  runStrategyAI,
  saveAIConfig,
} from "@/lib/market/quotes.functions";
import type { QueueEntry, QueuePayload } from "@/lib/market/factor-queue";
import type { Challenger } from "@/lib/market/challenger";
import { STYLES } from "@/lib/market/strategies";

type AIStatusPayload = {
  allowed: boolean;
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  keyTail: string | null;
};

type Loader = {
  queue: QueuePayload;
  ai: AIStatusPayload;
  chal: Challenger[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Route = createFileRoute("/ai")({
  loader: async (): Promise<Loader> => {
    const [queue, ai, chal] = await Promise.all([
      getFactorQueue().catch((e: unknown): QueuePayload => ({ entries: [], missing: messageOf(e) })),
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null })),
      getChallengers()
        .then((res) => res.list)
        .catch((): Challenger[] => []),
    ]);
    return { queue, ai, chal };
  },
  component: AIPage,
});

const QUEUE_STATUS: Record<QueueEntry["status"], { label: string; className: string }> = {
  pending: { label: "待验", className: "text-fg" },
  tested: { label: "在验·未过", className: "text-warn" },
  passed: { label: "已过 6 关", className: "text-up" },
  tombstone: { label: "已淘汰", className: "text-muted line-through" },
};

const CHAL_STATUS: Record<Challenger["status"], { label: string; className: string }> = {
  running: { label: "在跑", className: "text-fg" },
  promoted: { label: "已转正", className: "text-up" },
  rejected: { label: "已淘汰", className: "text-down" },
  inconclusive: { label: "停跑·未分胜负", className: "text-muted" },
};

/** 区块外壳，和因子页同一套。 */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-24 overflow-hidden rounded border border-line bg-surface">
      <header className="border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** 接口配置表单。只有主人看得到；key 只回尾号。 */
function ConfigBlock({ ai }: { ai: AIStatusPayload }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!ai.allowed) {
    return <p className="px-3.5 py-3 text-xs text-muted">只有主人账号能配置 AI 接口。</p>;
  }
  const save = async () => {
    try {
      const res = await saveAIConfig({ data: { baseUrl, apiKey, model } });
      setMessage(res.configured ? `已保存 ${res.baseUrl} · ${res.model} · key 尾号 ${res.keyTail ?? ""}`.trim() : "已清除 AI 配置");
      setBaseUrl("");
      setApiKey("");
      setModel("");
      await router.invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    }
  };
  return (
    <div className="px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">OpenAI 兼容接口（Ollama / LM Studio / DeepSeek 都行）</span>
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
      {message ? <p className="mt-1.5 text-xs text-muted">{message}</p> : null}
    </div>
  );
}

function AIPage() {
  const { queue, ai, chal } = Route.useLoaderData();
  const router = useRouter();
  const [factorMsg, setFactorMsg] = useState<string | null>(null);
  const [stratMsg, setStratMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"factor" | "strategy" | null>(null);

  const runFactor = async () => {
    setBusy("factor");
    setFactorMsg(null);
    try {
      const res = await runFactorAI();
      setFactorMsg(
        res.ok
          ? `本轮提议 ${res.proposed} 个进队列` +
              (res.rejected > 0 ? `，拒了 ${res.rejected} 个（${res.rejectReasons.slice(0, 2).join("；")}${res.rejectReasons.length > 2 ? "…" : ""}）` : "") +
              "。跑一次 BT_FACTOR=1 回测就会进 6 关检验。"
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
    <Frame aside="AI 管理">
      <Section
        title="AI 接口配置"
        hint="因子层和策略层共用一份配置。AI 的产出只许是白名单表达式（因子）或出场参数旋钮（策略），过不了校验的直接拒；判决永远由预先登记的函数说了算。"
      >
        <ConfigBlock ai={ai} />
      </Section>

      <Section
        title="因子层：待验队列"
        hint="AI 读最近一轮 6 关判决，针对败因提 1~3 个新假设；进队列后跑一次 BT_FACTOR=1 自动进检验，连续 2 次没过 6 关自动淘汰。"
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
              hint={ai.allowed ? "点上面的「让 AI 提议一轮新因子」；提议进队列后跑一次 BT_FACTOR=1 回测。" : "主人账号配置 AI 接口后可以自动补充新因子。"}
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
                    {c.note ? <span className="w-full text-[11px] text-muted">{c.note}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <StateBlock kind="empty" title="还没有挑战者" hint="点上面的「让 AI 提名挑战者」，或手工编辑 data/challengers.json（README 有模板）。" />
          )}
          <p className="mt-2 text-[11px] text-muted">
            当前 {runningCount} 个在跑 · <Link to="/positions" className="hover:text-fg hover:underline">去策略追踪看持仓明细 →</Link>
          </p>
        </div>
      </Section>

      <p className="px-1 text-[11px] leading-relaxed text-warn">
        AI 提议 ≠ 生效：因子要过 6 关，挑战者要过 30 笔 Welch 判决；两个判决函数都预先登记在代码里，AI 无权修改。
      </p>
    </Frame>
  );
}
