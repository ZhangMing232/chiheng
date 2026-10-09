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
  deleteAIProfile,
  getAILog,
  getAIStatus,
  getAIUsage,
  getChallengers,
  getFactorQueue,
  listAIModels,
  runEvolve,
  runFactorAI,
  runStrategyAI,
  saveAIPrefs,
  saveAIProfile,
  setActiveAIProfile,
  testAIProfile,
} from "@/lib/market/quotes.functions";
import { evolveStats, type AILogEntry } from "@/lib/market/ai-log";
import { usageStats, type AIUsageEntry, type UsageStats } from "@/lib/market/ai-usage";
import { PROVIDER_PRESETS } from "@/lib/market/ai-presets";
import type { QueueEntry, QueuePayload } from "@/lib/market/factor-queue";
import type { Challenger } from "@/lib/market/challenger";
import { STYLES } from "@/lib/market/strategies";

type ProfileStatus = { id: string; name: string; baseUrl: string; model: string; keyTail: string; pricePromptPerM: number | null; priceCompletionPerM: number | null };

type AIStatusPayload = {
  allowed: boolean;
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  keyTail: string | null;
  autoEvolve: boolean;
  activeId: string | null;
  profiles: ProfileStatus[];
};

type Loader = {
  queue: QueuePayload;
  ai: AIStatusPayload;
  chal: Challenger[];
  log: AILogEntry[];
  stats: ReturnType<typeof evolveStats>;
  usage: { allowed: boolean; entries: AIUsageEntry[]; stats: UsageStats | null };
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Route = createFileRoute("/ai")({
  loader: async (): Promise<Loader> => {
    const [queue, ai, chal, logRes, usage] = await Promise.all([
      getFactorQueue().catch((e: unknown): QueuePayload => ({ entries: [], missing: messageOf(e) })),
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [] })),
      getChallengers()
        .then((res) => res.list)
        .catch((): Challenger[] => []),
      getAILog().catch((): { allowed: boolean; entries: AILogEntry[] } => ({ allowed: false, entries: [] })),
      getAIUsage().catch((): Loader["usage"] => ({ allowed: false, entries: [], stats: null })),
    ]);
    const log = logRes.entries;
    return { queue, ai, chal, log, stats: evolveStats(log, queue.entries, chal), usage };
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

/** 接口档案编辑弹窗：新增 / 改档都走这里。选服务商预设后只填 API key 即可。 */
function ProfileModal({ editing, onClose }: { editing: ProfileStatus | null; onClose: () => void }) {
  const router = useRouter();
  const [presetId, setPresetId] = useState("custom");
  const [name, setName] = useState(editing?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(editing?.model ?? "");
  const [pricePrompt, setPricePrompt] = useState(editing?.pricePromptPerM != null ? String(editing.pricePromptPerM) : "");
  const [priceCompletion, setPriceCompletion] = useState(editing?.priceCompletionPerM != null ? String(editing.priceCompletionPerM) : "");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"fetch" | "test" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);

  /** 选服务商：baseUrl / 模型 / 候选清单自动带出来，用户只贴 key。 */
  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PROVIDER_PRESETS.find((item) => item.id === id);
    if (!p) return;
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    if (p.models.length > 0) {
      setModel(p.models[0]);
      setModels(p.models);
    }
    if (!editing && p.id !== "custom") setName(p.name);
  };

  const fetchModels = async () => {
    setBusy("fetch");
    setMessage(null);
    try {
      const res = await listAIModels({ data: { baseUrl, apiKey } });
      setModels(res.models);
      setMessage(res.models.length > 0 ? `拉到 ${res.models.length} 个模型，点输入框选` : "接口通了但没有模型清单，手填模型名");
    } catch (err) {
      setMessage(`拉模型失败：${err instanceof Error ? err.message : "未知原因"}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const res = await testAIProfile({ data: { baseUrl, apiKey, model, pricePromptPerM: pricePrompt, priceCompletionPerM: priceCompletion } });
      setMessage(res.ok ? `通了，${res.ms}ms` : `没通：${res.error ?? "未知原因"}（${res.ms}ms）`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "测试失败");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      await saveAIProfile({ data: { id: editing?.id, name, baseUrl, apiKey, model, pricePromptPerM: pricePrompt, priceCompletionPerM: priceCompletion } });
      await router.invalidate();
      onClose();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-fg/40" />
      <div className="relative w-full max-w-md rounded border border-line bg-surface shadow-lg">
        <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <h3 className="text-sm font-medium">{editing ? `编辑档案「${editing.name}」` : "新增接口档案"}</h3>
          <button type="button" onClick={onClose} className="text-xs text-muted hover:text-fg">
            关闭
          </button>
        </header>
        <div className="space-y-2 px-3.5 py-3">
          <label className="block text-xs text-muted">
            服务商（选了只填 API key 就行）
            <select
              value={presetId}
              onChange={(e) => applyPreset(e.target.value)}
              className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-brand"
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {preset?.hint ? (
            <p className="rounded border border-line bg-surface-2 px-2 py-1.5 text-[11px] leading-relaxed text-muted">{preset.hint}</p>
          ) : null}
          <label className="block text-xs text-muted">
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：DeepSeek 官方 / 本机 Ollama"
              className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
          <label className="block text-xs text-muted">
            baseUrl（OpenAI 兼容，/v1 结尾）
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
          <label className="block text-xs text-muted">
            API key{editing ? "（留空 = 不换）" : ""}
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder={editing ? `尾号 ${editing.keyTail}` : "sk-..."}
              className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
          </label>
          <label className="block text-xs text-muted">
            模型
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="ai-model-list"
              placeholder="deepseek-chat / qwen2.5:14b"
              className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
            />
            <datalist id="ai-model-list">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">
              Prompt 单价（元/百万 tokens，可空）
              <input
                value={pricePrompt}
                onChange={(e) => setPricePrompt(e.target.value)}
                inputMode="decimal"
                placeholder={preset?.priceHint?.prompt ?? "如 2"}
                className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
              />
            </label>
            <label className="block text-xs text-muted">
              Completion 单价（元/百万 tokens，可空）
              <input
                value={priceCompletion}
                onChange={(e) => setPriceCompletion(e.target.value)}
                inputMode="decimal"
                placeholder={preset?.priceHint?.completion ?? "如 8"}
                className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
              />
            </label>
          </div>
          <p className="text-[11px] text-muted">
            单价按各家官网核对后填（占位提示只是参考价）；调用发生时快照当时的价，以后改价不影响历史账。
          </p>
          {message ? <p className="text-xs text-muted">{message}</p> : null}
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button
            type="button"
            disabled={busy !== null || !baseUrl.trim()}
            onClick={() => void fetchModels()}
            className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "fetch" ? "拉取中…" : "从接口拉模型清单"}
          </button>
          <button
            type="button"
            disabled={busy !== null || !baseUrl.trim() || !apiKey.trim() || !model.trim()}
            onClick={() => void test()}
            className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "test" ? "测试中…" : "测试连通"}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy !== null || !name.trim() || !baseUrl.trim() || !model.trim() || (!editing && !apiKey.trim())}
            onClick={() => void save()}
            className="rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "save" ? "保存中…" : editing ? "保存修改" : "建档"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 接口档案管理：多套并存、启用一套、弹窗编辑。只有主人看得到；key 只回尾号。 */
function ConfigBlock({ ai }: { ai: AIStatusPayload }) {
  const router = useRouter();
  const [modal, setModal] = useState<ProfileStatus | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!ai.allowed) {
    return <p className="px-3.5 py-3 text-xs text-muted">只有主人账号能配置 AI 接口。</p>;
  }

  const activate = async (id: string) => {
    setMessage(null);
    try {
      await setActiveAIProfile({ data: { id } });
      await router.invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "切换失败");
    }
  };

  const remove = async (p: ProfileStatus) => {
    if (!window.confirm(`删掉档案「${p.name}」？${ai.activeId === p.id ? "它正在启用，删后闭环停在未配置。" : ""}`)) return;
    setMessage(null);
    try {
      await deleteAIProfile({ data: { id: p.id } });
      await router.invalidate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除失败");
    }
  };

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">OpenAI 兼容接口（DeepSeek / Ollama / LM Studio 都行），多套档案启用一套</span>
        <button
          type="button"
          onClick={() => setModal("new")}
          className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
        >
          新增接口
        </button>
      </div>
      {ai.profiles.length > 0 ? (
        <ul className="mt-2 divide-y divide-line rounded border border-line">
          {ai.profiles.map((p) => {
            const active = ai.activeId === p.id;
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                <span className={`font-medium ${active ? "text-brand-text" : ""}`}>
                  {p.name}
                  {active ? <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand-text">启用中</span> : null}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted">
                  {p.baseUrl} · {p.model} · key 尾号 {p.keyTail}
                </span>
                <span className="ml-auto flex shrink-0 gap-2">
                  {active ? null : (
                    <button type="button" onClick={() => void activate(p.id)} className="text-brand hover:underline">
                      启用
                    </button>
                  )}
                  <button type="button" onClick={() => setModal(p)} className="text-muted hover:text-fg hover:underline">
                    编辑
                  </button>
                  <button type="button" onClick={() => void remove(p)} className="text-muted hover:text-down hover:underline">
                    删除
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 rounded border border-dashed border-line px-3 py-2.5 text-xs text-muted">
          还没有档案。点「新增接口」填一套 DeepSeek / Ollama / LM Studio 的地址和 key，填过的东西都会留住，随时切换。
        </p>
      )}
      {ai.configured ? null : <p className="mt-1.5 text-[11px] text-warn">当前没有启用中的档案——闭环和自动进化都不会跑，先启用一套。</p>}
      {message ? <p className="mt-1.5 text-xs text-muted">{message}</p> : null}
      {modal ? <ProfileModal editing={modal === "new" ? null : modal} onClose={() => setModal(null)} /> : null}
    </div>
  );
}

/** Token 用量监控：统计卡 + 7 天趋势 + 按模型分桶 + 最近流水。 */
function UsageSection({ usage }: { usage: Loader["usage"] }) {
  const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));
  const fmtCost = (n: number): string => `¥${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
  if (!usage.allowed) {
    return <p className="px-3.5 py-3 text-xs text-muted">只有主人账号能看用量监控。</p>;
  }
  const s = usage.stats;
  if (!s || s.totalCalls === 0) {
    return (
      <div className="px-3.5 py-3">
        <StateBlock kind="empty" title="还没有用量记录" hint="每次调 AI（跑进化、测连通）都会自动记账；跑一轮完整进化后再来看。" />
      </div>
    );
  }
  const maxDayTokens = Math.max(...s.last7Days.map((d) => d.tokens), 1);
  const models = Object.entries(s.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  return (
    <div>
      <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "总调用 / 成功", value: `${s.totalCalls} / ${s.okCalls}`, sub: s.failCalls > 0 ? `失败 ${s.failCalls}` : "无失败" },
          { label: "Prompt tokens", value: fmt(s.promptTokens), sub: "输入" },
          { label: "Completion tokens", value: fmt(s.completionTokens), sub: "输出" },
          { label: "总 tokens", value: fmt(s.totalTokens), sub: "按接口报数" },
          { label: "平均耗时", value: `${Math.round(s.totalMs / Math.max(s.totalCalls, 1))}ms`, sub: "单次调用" },
          {
            label: "费用合计",
            value: s.pricedCalls > 0 ? fmtCost(s.totalCost) : "未计价",
            sub: s.pricedCalls > 0 ? `${s.pricedCalls} 次有单价快照` : "在档案弹窗填单价才算",
          },
        ].map((c) => (
          <div key={c.label} className="bg-surface px-3.5 py-2.5">
            <div className="text-[10px] tracking-widest text-muted">{c.label}</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">{c.value}</div>
            <div className="text-[11px] text-muted">{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line px-3.5 py-2.5">
        <span className="text-[10px] tracking-widest text-muted">近 7 天</span>
        {s.last7Days.map((d) => (
          <div key={d.date} className="flex items-end gap-1" title={`${d.date}：${d.tokens} tokens / ${d.calls} 次${d.cost > 0 ? ` / ${fmtCost(d.cost)}` : ""}`}>
            <div className="flex h-8 w-4 items-end rounded-sm bg-surface-2">
              <div className="w-full rounded-sm bg-brand" style={{ height: `${Math.max((d.tokens / maxDayTokens) * 100, d.tokens > 0 ? 8 : 0)}%` }} />
            </div>
            <span className="text-[10px] text-muted">{d.date.slice(5)}</span>
          </div>
        ))}
      </div>
      {models.length > 1 ? (
        <div className="border-b border-line px-3.5 py-2.5">
          <div className="text-[10px] tracking-widest text-muted">按模型</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {models.map(([model, m]) => (
              <li key={model} className="flex flex-wrap gap-x-3">
                <span className="font-mono">{model}</span>
                <span className="text-muted">
                  {m.calls} 次 · {fmt(m.tokens)} tokens{m.cost > 0 ? ` · ${fmtCost(m.cost)}` : ""} · 平均 {Math.round(m.ms / Math.max(m.calls, 1))}ms
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="px-3.5 py-3">
        <Table className="data-table" caption="最近调用流水：token 数来自接口响应的 usage 字段，接口不报就记 0；费用按调用时档案里的单价快照算">
          <thead>
            <tr className="border-b border-line">
              <th className={thClass()}>时间</th>
              <th className={thClass()}>链路</th>
              <th className={thClass()}>模型</th>
              <th className={thClass()}>Prompt</th>
              <th className={thClass()}>Completion</th>
              <th className={thClass()}>费用</th>
              <th className={thClass()}>耗时</th>
              <th className={thClass()}>结果</th>
            </tr>
          </thead>
          <tbody>
            {[...usage.entries].reverse().slice(0, 20).map((e, i) => (
              <tr key={`${e.at}-${i}`} className="border-b border-line last:border-b-0">
                <td data-l="时间" className="px-2.5 py-1.5 whitespace-nowrap text-[11px] text-muted">
                  {e.at.slice(5, 16).replace("T", " ")}
                </td>
                <td data-l="链路" className="px-2.5 py-1.5 text-[11px] text-muted">
                  {e.layer === "factor" ? "因子" : e.layer === "strategy" ? "策略" : e.layer === "test" ? "测试" : e.layer}
                  {e.trigger === "auto" ? "·自动" : ""}
                </td>
                <td data-l="模型" className="max-w-[16ch] truncate px-2.5 py-1.5 font-mono text-[11px] text-muted">
                  {e.model}
                </td>
                <td data-l="Prompt" className="px-2.5 py-1.5 text-right text-[11px] tabular-nums">
                  {e.promptTokens.toLocaleString()}
                </td>
                <td data-l="Completion" className="px-2.5 py-1.5 text-right text-[11px] tabular-nums">
                  {e.completionTokens.toLocaleString()}
                </td>
                <td data-l="费用" className="px-2.5 py-1.5 text-right text-[11px] tabular-nums">
                  {e.cost > 0 ? fmtCost(e.cost) : "—"}
                </td>
                <td data-l="耗时" className="px-2.5 py-1.5 text-right text-[11px] tabular-nums text-muted">
                  {e.ms}ms
                </td>
                <td data-l="结果" className={`px-2.5 py-1.5 text-[11px] ${e.ok ? "text-up" : "text-down"}`}>
                  {e.ok ? "成功" : e.error ? `失败：${e.error.length > 48 ? `${e.error.slice(0, 48)}…` : e.error}` : "失败"}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-1.5 text-[11px] text-muted">费用 = 调用时档案里的单价快照 × 实际 tokens；改价只影响之后的新账，历史账不改口径。没填价的调用只统计 tokens 不算钱。</p>
      </div>
    </div>
  );
}

function AIPage() {
  const { queue, ai, chal, log, stats, usage } = Route.useLoaderData();
  const router = useRouter();
  const [factorMsg, setFactorMsg] = useState<string | null>(null);
  const [stratMsg, setStratMsg] = useState<string | null>(null);
  const [evolveMsg, setEvolveMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"factor" | "strategy" | "evolve" | null>(null);

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

  /** 一键完整进化：因子层 → 策略层，两层各自记账，结果拼一句汇报。 */
  const runEvolveOnce = async () => {
    setBusy("evolve");
    setEvolveMsg(null);
    try {
      const res = await runEvolve();
      const part = (label: string, r: { ok: boolean; proposed: number; error?: string }): string =>
        `${label} ${r.ok ? `进 ${r.proposed} 个` : `没跑成（${r.error ?? "?"}）`}`;
      setEvolveMsg(`${part("因子层", res.factor)} · ${part("策略层", res.strategy)}。下一轮 prompt 会读到这两轮的下场，据此自我纠错。`);
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "运行失败");
    } finally {
      setBusy(null);
    }
  };

  /** 自动进化开关：收盘后记账进程每天自动跑一轮（ai-log 去重，每天最多一轮）。 */
  const toggleAuto = async (next: boolean) => {
    try {
      await saveAIPrefs({ data: { autoEvolve: next } });
      await router.invalidate();
    } catch (err) {
      setEvolveMsg(err instanceof Error ? err.message : "保存开关失败");
    }
  };

  const styleName = (id: string) => STYLES.find((s) => s.id === id)?.name ?? id;
  const runningCount = chal.filter((c) => c.status === "running").length;

  return (
    <Frame aside="AI 管理">
      <Section
        title="AI 接口配置"
        hint="多套接口档案并存、启用一套跑所有闭环（因子层 / 策略层 / 自动进化共用）。AI 的产出只许是白名单表达式（因子）或出场参数旋钮（策略），过不了校验的直接拒；判决永远由预先登记的函数说了算。"
      >
        <ConfigBlock ai={ai} />
      </Section>

      <Section
        title="进化控制台"
        hint="自我迭代的闭环：AI 每轮提议都进账本，下一轮 prompt 会读到这些提议的下场（过没过 6 关、转正还是淘汰），据此纠错。开自动进化后，收盘后每天自己跑一轮。"
      >
        <div className="border-b border-line px-3.5 py-2">
          {ai.allowed ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                disabled={busy !== null || !ai.configured}
                onClick={() => void runEvolveOnce()}
                className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "evolve" ? "AI 进化中…" : "跑一轮完整进化"}
              </button>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={ai.autoEvolve}
                  onChange={(e) => void toggleAuto(e.target.checked)}
                  className="accent-brand"
                />
                收盘后每天自动进化一轮
              </label>
              {evolveMsg ? <span className="min-w-0 basis-full text-xs text-muted">{evolveMsg}</span> : null}
            </div>
          ) : (
            <p className="text-xs text-muted">主人账号登录后可运行进化和开关自动模式。</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
          {[
            { label: "因子层轮数", value: stats.factorRounds, sub: `AI 提议 ${stats.factorProposed} 个` },
            { label: "因子过关 / 淘汰", value: `${stats.factorPassed} / ${stats.factorTombstoned}`, sub: "过 6 关 / 连续 2 次未过" },
            { label: "策略层轮数", value: stats.strategyRounds, sub: `AI 提名 ${stats.chalNominated} 个` },
            { label: "挑战者转正 / 淘汰", value: `${stats.chalPromoted} / ${stats.chalRejected}`, sub: "Welch 判决产物" },
          ].map((s) => (
            <div key={s.label} className="bg-surface px-3.5 py-2.5">
              <div className="text-[10px] tracking-widest text-muted">{s.label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{s.value}</div>
              <div className="text-[11px] text-muted">{s.sub}</div>
            </div>
          ))}
        </div>
        <div className="px-3.5 py-3">
          {log.length > 0 ? (
            <Table className="data-table" caption="AI 运行账本：每轮提议、被拒原因都记着，下一轮 prompt 会读到">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>时间</th>
                  <th className={thClass()}>层</th>
                  <th className={thClass()}>触发</th>
                  <th className={thClass()}>结果</th>
                  <th className={thClass("text-left")}>提议</th>
                  <th className={thClass("text-left")}>被拒 / 报错</th>
                </tr>
              </thead>
              <tbody>
                {[...log].reverse().slice(0, 20).map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="px-2.5 py-1.5 whitespace-nowrap text-[11px] text-muted">
                      {e.at.slice(0, 16).replace("T", " ")}
                    </td>
                    <td data-l="层" className="px-2.5 py-1.5 text-[11px]">
                      {e.layer === "factor" ? "因子" : "策略"}
                    </td>
                    <td data-l="触发" className="px-2.5 py-1.5 text-[11px] text-muted">
                      {e.trigger === "auto" ? "自动" : "手动"}
                    </td>
                    <td data-l="结果" className={`px-2.5 py-1.5 text-[11px] ${e.ok ? "text-up" : "text-down"}`}>
                      {e.ok ? `进 ${e.proposed.length}` : "失败"}
                    </td>
                    <td data-l="提议" className="max-w-[28ch] px-2.5 py-1.5 text-[11px] text-muted">
                      {e.proposed.length > 0 ? e.proposed.map((p) => p.name).join("、") : "—"}
                    </td>
                    <td data-l="被拒" className="max-w-[32ch] px-2.5 py-1.5 text-[11px] text-muted">
                      {e.error ?? (e.rejected.length > 0 ? e.rejected.slice(0, 2).join("；") : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <StateBlock kind="empty" title="还没有运行记录" hint="点上面的「跑一轮完整进化」，或开自动进化让记账进程收盘后自己跑。" />
          )}
        </div>
      </Section>

      <Section
        title="Token 用量监控"
        hint="每次调 AI 自动记账：输入/输出/总 tokens、耗时、成败、哪条链路（因子/策略/测试）烧的。接口不返回 usage 就记 0，不瞎编。"
      >
        <UsageSection usage={usage} />
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
