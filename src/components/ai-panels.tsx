/**
 * 这个文件是干什么的：
 * 「AI 管理」区（/ai 下）各子页面共用的部件：区块外壳 Section、接口档案编辑弹窗
 * （ProfileModal）、闸门与判据（RulesSection），以及这一区统一的二级 tab。
 * 接口配置卡片和 Token 用量的页面本体在各自路由文件里（2026-11-06 按新效果图重排）。
 *
 * 你需要知道的：
 * - 2026-10-21 AI 管理页从「本地状态的 PageTabs」改成真实子页面
 *   （/ai/ AI 控制中枢、/ai/config 接口配置、/ai/usage Token 用量、/ai/rules 闸门与判据），
 *   刷新、书签都落在具体子页。
 * - apiKey 是密钥：服务端只回尾四位，完整值不出服务端；配置入口只给主人账号。
 * - 闸门与判据的数值运行时才从常量拼（system-rules.ts），这里不写字面量——
 *   防止面板数字和代码常量脱钩。
 */

import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CollapsibleSection } from "@/components/collapsible";
import { SectionTabs } from "@/components/section-tabs";
import { Table, tdClass, thClass } from "@/components/terminal";
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
        { to: "/ai", label: "AI 控制中枢" },
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
            <p className="rounded border border-line bg-surface-2 px-2 py-1.5 text-[12px] leading-relaxed text-muted">{preset.hint}</p>
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
          <p className="text-[12px] text-muted">
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
              <span className="text-[12px] text-muted">{g.source}</span>
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
        <p className="text-[12px] leading-relaxed text-muted">
          只读：数值是运行时从代码常量拼的，改阈值要到对应文件改常量提交（改规则要带理由）。「block 级」= 不过就熔断当晚判决；「warn 级」= 记账不挡跑。
        </p>
      </div>
    </CollapsibleSection>
  );
}
