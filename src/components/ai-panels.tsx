/**
 * 这个文件是干什么的：
 * 「AI 管理」区（/ai 下）各子页面共用的面板：区块外壳 Section、接口档案编辑弹窗
 * （ProfileModal）、接口配置（ConfigBlock）、Token 用量监控（UsageSection）、
 * 闸门与判据（RulesSection），以及这一区统一的二级 tab。
 *
 * 你需要知道的：
 * - 2026-10-21 AI 管理页从「本地状态的 PageTabs」改成真实子页面
 *   （/ai/ 进化控制台、/ai/config 接口配置、/ai/usage Token 用量、/ai/rules 闸门与判据），
 *   刷新、书签都落在具体子页。本文件是从 routes/ai.tsx 抽出来的纯展示/交互部分，
 *   不含 loader 和路由。
 * - apiKey 是密钥：服务端只回尾四位，完整值不出服务端；配置入口只给主人账号。
 * - 闸门与判据的数值运行时才从常量拼（system-rules.ts），这里不写字面量——
 *   防止面板数字和代码常量脱钩。
 */

import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CollapsibleSection } from "@/components/collapsible";
import { SectionTabs } from "@/components/section-tabs";
import { Table, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import {
  deleteAIProfile,
  listAIModels,
  saveAIProfile,
  setActiveAIProfile,
  testAIProfile,
} from "@/lib/market/quotes.functions";
import type { AIUsageEntry, UsageStats } from "@/lib/market/ai-usage";
import { PROVIDER_PRESETS } from "@/lib/market/ai-presets";
import type { RuleGroup } from "@/lib/market/system-rules";

export type ProfileStatus = { id: string; name: string; baseUrl: string; model: string; keyTail: string; pricePromptPerM: number | null; priceCompletionPerM: number | null };

export type AIStatusPayload = {
  allowed: boolean;
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  keyTail: string | null;
  autoEvolve: boolean;
  activeId: string | null;
  profiles: ProfileStatus[];
  /** 主备切换链（与 callAIWithFallback 同源）：超时/报错按序自动切，封顶两个。 */
  fallbackOrder: string[];
};

/** Token 用量的 loader 形状（getAIUsage 的返回）。 */
export type UsagePayload = { allowed: boolean; entries: AIUsageEntry[]; stats: UsageStats | null };

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 这一区统一的二级 tab：/ai 下所有子页面共用，增删子页只改这里。 */
export function AISectionTabs() {
  return (
    <SectionTabs
      ariaLabel="AI 管理"
      tabs={[
        { to: "/ai", label: "进化控制台" },
        { to: "/ai/config", label: "接口配置" },
        { to: "/ai/usage", label: "Token 用量" },
        { to: "/ai/rules", label: "闸门与判据" },
      ]}
    />
  );
}

/** 区块外壳，和因子页同一套。id 供首页 AI 控制台的示例卡跳转（UI-STANDARD U5）。 */
export function Section({ id, title, hint, children }: { id?: string; title: string; hint?: string; children: React.ReactNode }) {
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

/** 接口档案编辑弹窗：新增 / 改档都走这里。选服务商预设后只填 API key 即可。 */
export function ProfileModal({ editing, onClose }: { editing: ProfileStatus | null; onClose: () => void }) {
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
            单价留空会自动按内置参考价填入（2026-10 核对的官方价，元/百万 tokens），和你的套餐不一致就在上面改；
            调用发生时快照当时的价，以后改价不影响历史账。没进参考表的模型不填价就只统计 tokens 不算钱。
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
export function ConfigBlock({ ai }: { ai: AIStatusPayload }) {
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
      {ai.fallbackOrder.length > 1 ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          切换链：主档案超时/报错自动按序切到下一个（封顶两个），
          <span className="font-mono">{ai.fallbackOrder.join(" → ")}</span>
          ；每次调用按实际出活的档案单价记账，用量监控台看得到。
        </p>
      ) : null}
      {ai.configured ? null : <p className="mt-1.5 text-[11px] text-warn">当前没有启用中的档案——闭环和自动进化都不会跑，先启用一套。</p>}
      {message ? <p className="mt-1.5 text-xs text-muted">{message}</p> : null}
      {modal ? <ProfileModal editing={modal === "new" ? null : modal} onClose={() => setModal(null)} /> : null}
    </div>
  );
}


/** Token 用量监控：统计卡 + 7 天趋势 + 按模型分桶 + 最近流水。 */
export function UsageSection({ usage }: { usage: UsagePayload }) {
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
            label: "费用合计（已计价）",
            value: s.pricedCalls > 0 ? fmtCost(s.totalCost) : "无快照",
            sub: s.pricedCalls > 0 ? `${s.pricedCalls} 次调用时填了价` : "历史调用都没填价",
          },
          {
            label: "估算合计（按现价）",
            value: s.estCalls > 0 ? `≈${fmtCost(s.estCost)}` : "—",
            sub: s.estCalls > 0 ? `${s.estCalls} 次历史账按现行参考价补算` : "无可估算项",
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
                  {m.calls} 次 · {fmt(m.tokens)} tokens
                  {m.cost > 0 ? ` · ${fmtCost(m.cost)}` : ""}
                  {m.estCost > 0 ? ` · 估算 ≈${fmtCost(m.estCost)}` : ""}
                  {" "}· 平均 {Math.round(m.ms / Math.max(m.calls, 1))}ms
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
        <p className="mt-1.5 text-[11px] text-muted">
          已计价 = 调用时档案里的单价快照 × 实际 tokens，历史账永不改口径；估算 = 没快照的历史账按现行参考价（ai-prices，2026-10 核对的官方价）补算，仅供参考。
          DeepSeek 高峰时段（北京时间工作日 09:00-12:00、14:00-18:00）实付为估算的 2 倍，命中缓存会更便宜——表按保守口径（全量 miss + 谷时价）计。
        </p>
      </div>
    </div>
  );
}

/**
 * 闸门与判据面板：五组预登记阈值（数据审计/熔断/衰减/挑战者/策略闸门）的当前值。
 * 低频参考内容，按 UI 标准默认收起；summary 行给每组的「最要害一个数」，
 * 展开后是「判据 · 当前值 · 超了会怎样」三列。数值运行时才从常量拼（system-rules.ts），
 * 这里不写字面量——防止面板数字和代码常量脱钩。
 */
export function RulesSection({ groups }: { groups: RuleGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <CollapsibleSection
      storageKey="ai-rules-panel-2026-10-11"
      defaultOpen={false}
      header={
        <span>
          <span className="text-sm font-medium">闸门与判据</span>
          <span className="ml-2 text-xs text-muted">
            熔断连续 {groups.find((g) => g.id === "breaker")?.entries[0]?.value ?? "—"} · 共 {groups.length} 组
          </span>
        </span>
      }
      className="overflow-hidden rounded border border-line bg-surface"
      headerClassName="border-b border-line px-3.5 py-2"
    >
      <div className="space-y-3 px-3.5 py-3">
        {groups.map((g) => (
          <div key={g.id}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h3 className="text-xs font-medium">{g.title}</h3>
              <span className="text-[11px] text-muted">{g.source}</span>
            </div>
            <Table className="data-table mt-1">
              <tbody>
                {g.entries.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-b-0">
                    <td className={`${tdClass("text-left")} w-40 shrink-0 whitespace-normal`}>{e.label}</td>
                    <td className={`${tdClass()} whitespace-normal font-medium`}>{e.value}</td>
                    <td className={`${tdClass("text-left")} text-muted`}>{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
        <p className="text-[11px] leading-relaxed text-muted">
          只读：数值是运行时从代码常量拼的，改阈值要到对应文件改常量提交（改规则要带理由）。「block 级」= 不过就熔断当晚判决；「warn 级」= 记账不挡跑。
        </p>
      </div>
    </CollapsibleSection>
  );
}
