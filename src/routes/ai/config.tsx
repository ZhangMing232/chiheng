/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「接口配置」子页（/ai/config）。多套接口档案并存、启用一套
 * 跑所有闭环（因子层 / 策略层 / 自动进化共用）。
 *
 * 你需要知道的：
 * - 2026-11-06 按 AI 区新效果图重排：顶部真实统计卡 + 每套档案一张供应商卡
 *   （延迟/成功率来自 Token 用量账按模型聚合，调用过才有数，没调用写「还没调用过」，
 *   不编一个 99.8%）。效果图里的「在线/386ms/¥0.012」是拍脑袋数字，不抄。
 * - apiKey 是密钥：服务端只回尾四位，完整值不出服务端；配置入口只给主人账号。
 * - 选服务商预设后只填 API key 即可；单价留空自动按内置参考价填入。
 * - AI 的产出只许是白名单表达式（因子）或出场参数旋钮（策略），过不了校验
 *   的直接拒；判决永远由预先登记的函数说了算。
 */

import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Tag } from "@/components/terminal";
import { AiStat, GlowPanel } from "@/components/ai-kit";
import { Bot, Cable, Timer, Wallet } from "lucide-react";
import {
  deleteAIProfile,
  getAIStatus,
  getAIUsage,
  setActiveAIProfile,
} from "@/lib/market/quotes.functions";
import { AISectionTabs, ProfileModal, messageOf, type AIStatusPayload, type UsagePayload } from "@/components/ai-panels";

export const Route = createFileRoute("/ai/config")({
  loader: async () => {
    const [ai, usage] = await Promise.all([
      getAIStatus().catch((): AIStatusPayload => ({ allowed: false, configured: false, baseUrl: null, model: null, keyTail: null, autoEvolve: false, activeId: null, profiles: [], fallbackOrder: [] })),
      getAIUsage().catch((): UsagePayload => ({ allowed: false, entries: [], stats: null })),
    ]);
    // 「近 7 天」窗口的基准时刻随 loader 数据序列化，SSR 与 hydration 用同一个值。
    return { ai, usage, serverNow: Date.now() };
  },
  component: AIConfigPage,
});

function AIConfigPage() {
  const { ai, usage, serverNow } = Route.useLoaderData();
  const router = useRouter();
  const [modal, setModal] = useState<null | "new" | (typeof ai.profiles)[number]>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!ai.allowed) {
    return (
      <Frame wide aside="AI 管理 · 接口配置">
        <AISectionTabs />
        <p className="rounded border border-line bg-surface px-3.5 py-3 text-xs text-muted">只有主人账号能配置 AI 接口。</p>
      </Frame>
    );
  }

  const activate = async (id: string) => {
    setMessage(null);
    try {
      await setActiveAIProfile({ data: { id } });
      await router.invalidate();
    } catch (err) {
      setMessage(messageOf(err));
    }
  };

  const remove = async (p: (typeof ai.profiles)[number]) => {
    if (!window.confirm(`删掉档案「${p.name}」？${ai.activeId === p.id ? "它正在启用，删后闭环停在未配置。" : ""}`)) return;
    setMessage(null);
    try {
      await deleteAIProfile({ data: { id: p.id } });
      await router.invalidate();
    } catch (err) {
      setMessage(messageOf(err));
    }
  };

  // 近 7 天按模型聚合：成功率 / 平均耗时（调用过才有数）
  const sevenIso = new Date(serverNow - 7 * 86_400_000).toISOString();
  const recent = usage.entries.filter((e) => e.at >= sevenIso);
  const byModel = new Map<string, { calls: number; ok: number; ms: number }>();
  for (const e of recent) {
    const m = byModel.get(e.model) ?? { calls: 0, ok: 0, ms: 0 };
    m.calls += 1;
    if (e.ok) m.ok += 1;
    m.ms += e.ms;
    byModel.set(e.model, m);
  }
  const recentCalls = recent.length;
  const recentOk = recent.filter((e) => e.ok).length;
  const recentRate = recentCalls > 0 ? Math.round((recentOk / recentCalls) * 100) : null;
  const recentAvgMs = recentCalls > 0 ? Math.round(recent.reduce((a, e) => a + e.ms, 0) / recentCalls) : null;
  const priced = usage.stats;

  return (
    <Frame wide aside="AI 管理 · 接口配置">
      <AISectionTabs />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-xl font-medium tracking-wide">AI 接口与模型</h1>
        <span className="text-xs text-muted">多供应商接入、主备自动切换，为策略研究提供稳定的 AI 能力。</span>
      </div>

      {/* 统计卡：全部来自用量账，没有调用就写没有 */}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <AiStat icon={<Cable size={16} />} label="接口档案" value={`${ai.profiles.length} 套`} sub={ai.activeId ? `启用中：${ai.profiles.find((p) => p.id === ai.activeId)?.name ?? "—"}` : "没有启用中的档案"} />
        <AiStat icon={<Bot size={16} />} label="近 7 天调用" value={recentCalls} sub={recentRate != null ? `成功率 ${recentRate}%` : "还没有调用"} />
        <AiStat icon={<Timer size={16} />} label="近 7 天平均耗时" value={recentAvgMs != null ? `${(recentAvgMs / 1000).toFixed(1)}s` : "—"} sub="单次调用，含排队" />
        <AiStat
          icon={<Wallet size={16} />}
          label="费用合计（已计价）"
          value={priced && priced.pricedCalls > 0 ? `¥${priced.totalCost.toFixed(2)}` : "无快照"}
          sub={priced && priced.pricedCalls > 0 ? `${priced.pricedCalls} 次调用时填了价` : "历史调用都没填价"}
        />
      </div>

      {/* 供应商卡片 */}
      <div className="mt-3 flex flex-col gap-3">
        {ai.profiles.length > 0 ? (
          ai.profiles.map((p) => {
            const active = ai.activeId === p.id;
            const m = byModel.get(p.model);
            return (
              <div
                key={p.id}
                className={`rounded-lg border bg-surface px-4 py-3 ${active ? "border-ai-line shadow-[0_0_0_1px_var(--color-ai-line)]" : "border-line"}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-sm font-medium text-fg">{p.name}</span>
                  {active ? (
                    <>
                      <Tag tone="brand">主接口</Tag>
                      <Tag tone="up">当前使用</Tag>
                    </>
                  ) : (
                    <Tag tone="muted">备用档案</Tag>
                  )}
                  <span className="ml-auto flex shrink-0 gap-2 text-xs">
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
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted sm:grid-cols-4">
                  <span className="min-w-0 truncate font-mono" title={p.baseUrl}>
                    {p.baseUrl}
                  </span>
                  <span className="font-mono">{p.model}</span>
                  <span className="tabular-nums">key 尾号 {p.keyTail}</span>
                  <span className="tabular-nums">
                    {p.pricePromptPerM != null || p.priceCompletionPerM != null
                      ? `¥${p.pricePromptPerM ?? "?"}/${p.priceCompletionPerM ?? "?"} 每百万`
                      : "未填单价"}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-muted">
                  {m
                    ? `近 7 天：${m.calls} 次调用 · 成功率 ${Math.round((m.ok / m.calls) * 100)}% · 平均 ${(m.ms / m.calls / 1000).toFixed(1)}s`
                    : "近 7 天这个模型还没被调用过——上面的数字要等真调用才有，不预填。"}
                </p>
              </div>
            );
          })
        ) : (
          <p className="rounded border border-dashed border-line px-3 py-3 text-xs text-muted">
            还没有档案。点「新增接口」填一套 DeepSeek / Ollama / LM Studio 的地址和 key，填过的东西都会留住，随时切换。
          </p>
        )}
        <button
          type="button"
          onClick={() => setModal("new")}
          className="shrink-0 self-start rounded bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
        >
          ＋ 新增接口
        </button>
      </div>

      {/* 自动切换：真实的主备链 */}
      <GlowPanel className="mt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <p className="text-xs font-medium text-ai">自动切换策略</p>
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
            {ai.fallbackOrder.length > 1 ? (
              <>
                主档案超时/报错自动按序切到下一个（封顶两个）：
                <span className="font-mono"> {ai.fallbackOrder.join(" → ")}</span>
                ；每次调用按实际出活的档案单价记账。
              </>
            ) : (
              "当前只有一套档案（或只启用了一套），没配切换链。多建一套备用档案并启用主备后，超时/报错会自动按序切换。"
            )}
          </p>
        </div>
      </GlowPanel>

      {ai.configured ? null : <p className="mt-2 text-[12px] text-warn">当前没有启用中的档案——闭环和自动进化都不会跑，先启用一套。</p>}
      {message ? <p className="mt-2 text-xs text-muted">{message}</p> : null}
      {modal ? <ProfileModal editing={modal === "new" ? null : modal} onClose={() => setModal(null)} /> : null}
    </Frame>
  );
}
