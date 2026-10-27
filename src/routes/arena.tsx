/**
 * 策略竞技场 + 每日信号清单。
 * - 上半屏：今日信号（收盘初筛 → 竞价审核 → 可执行清单）
 * - 下半屏：策略管理（AI帮写/手工表达式 + 回测）
 */

import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { Swords, Plus, Trash2, Sparkles, WandIcon, Zap, AlertTriangle, CheckCircle } from "lucide-react";
import { expressNaturalLanguage, getSignalCandidates, getSignalReviewed } from "@/lib/market/quotes.functions";
import type { SignalCandidate, SignalReviewed as SignalReviewedType } from "@/lib/market/quotes.functions";
import { validateFactorExpr } from "@/lib/market/factor-expr";

const SIGNALS_DIR = "data/signals";
const STRATEGIES_FILE = "data/strategies/user-defined.json";

// ---- 类型 ----

interface UserStrategy {
  id: string; name: string; expr: string; direction: 1 | -1; holdDays: number;
  stopPct: number | null; targetPct: number | null; note: string; source: "ai" | "manual"; createdAt: string;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export const Route = createFileRoute("/arena")({
  loader: async () => {
    let strategies: UserStrategy[] = [];
    // 策略仍在 loader 里读（需要 node:fs），但有 typeof window 守卫
    if (typeof window === "undefined") {
      try {
        const { readFile } = await import("node:fs/promises");
        try { const raw = await readFile(STRATEGIES_FILE, "utf8"); strategies = JSON.parse(raw); if (!Array.isArray(strategies)) strategies = []; } catch {}
      } catch {}
    }
    return { strategies };
  },
  component: ArenaPage,
});

async function saveStrategies(list: UserStrategy[]) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("data/strategies", { recursive: true });
  await writeFile(STRATEGIES_FILE, JSON.stringify(list, null, 2));
}

// ---- 信号卡片组件 ----

function SignalCards({ title, signals, variant }: { title: string; signals: SignalCandidate[] | SignalReviewedType[]; variant: "candidate" | "reviewed" }) {
  if (signals.length === 0) return null;
  const isReviewed = variant === "reviewed";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {isReviewed ? <CheckCircle size={12} className="text-up" /> : <Zap size={12} className="text-brand" />}
        <span>{title} ({signals.length})</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {signals.map((s, i) => {
          const r = s as SignalReviewedType;
          const hasReview = isReviewed && r.verdict;
          return (
          <div key={`${s.id}-${i}`} className={`flex flex-col gap-1 rounded border p-2.5 text-xs ${
            hasReview
              ? r.verdict === "ok" ? "border-up/40 bg-up/5" : r.verdict === "warn" ? "border-yellow-500/40 bg-yellow-500/5" : "border-line bg-surface"
              : "border-line bg-surface"
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm">{s.name}</span>
                <span className="text-[10px] text-muted tabular-nums">{s.code}</span>
              </div>
              {hasReview && r.verdict === "ok" && <CheckCircle size={12} className="text-up" />}
              {hasReview && r.verdict === "warn" && <AlertTriangle size={12} className="text-yellow-500" />}
            </div>
            <div className="flex items-center gap-2 text-muted">
              <span className="rounded bg-surface2 px-1 py-0.5 text-[10px]">{s.strategy}</span>
              <span className="tabular-nums">挂 {s.buyPrice}</span>
            </div>
            <p className="text-[11px] text-muted">{s.reason}</p>
            {hasReview && r.verdictReason && (
              <p className={`text-[11px] ${r.verdict === "ok" ? "text-up" : "text-yellow-500"}`}>
                {r.verdict === "ok" ? "✓ " : "⚠ "}{r.verdictReason}
              </p>
            )}
            {hasReview && r.auctionGap != null && (
              <div className="flex gap-2 text-[10px] text-muted">
                <span>竞价 {r.auctionPrice}</span>
                <span className={r.auctionGap > 0 ? "text-up" : "text-down"}>
                  {r.auctionGap > 0 ? "+" : ""}{r.auctionGap}%
                </span>
              </div>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- 页面主体 ----

function ArenaPage() {
  const { strategies: initial } = Route.useLoaderData();
  const [list, setList] = useState<UserStrategy[]>(initial);

  // 信号数据走 server function（客户端也可用）
  const { data: candidates = [] } = useQuery({
    queryKey: ["signalCandidates"],
    queryFn: async () => (await getSignalCandidates()).signals,
    staleTime: 60_000,
  });
  const { data: reviewed = [] } = useQuery({
    queryKey: ["signalReviewed"],
    queryFn: async () => (await getSignalReviewed()).signals,
    staleTime: 60_000,
  });
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [showForm, setShowForm] = useState(false);
  const [nl, setNl] = useState(""); const [aiExpr, setAiExpr] = useState(""); const [aiBusy, setAiBusy] = useState(false); const [aiError, setAiError] = useState("");
  const [manualExpr, setManualExpr] = useState(""); const [exprError, setExprError] = useState("");
  const [name, setName] = useState(""); const [dir, setDir] = useState<1 | -1>(1);
  const [holdDays, setHoldDays] = useState(5); const [stopPct, setStopPct] = useState(""); const [targetPct, setTargetPct] = useState("");
  const [note, setNote] = useState(""); const [saving, setSaving] = useState(false);
  const expr = mode === "ai" ? aiExpr : manualExpr;

  async function generateExpr() {
    if (!nl.trim()) return; setAiBusy(true); setAiError(""); setAiExpr("");
    try { const res = await expressNaturalLanguage({ data: { q: nl.trim() } }); res.ok ? setAiExpr(res.expr) : setAiError(res.error ?? "生成失败"); } catch (e) { setAiError(e instanceof Error ? e.message : String(e)); } finally { setAiBusy(false); }
  }
  function validateManual() { const r = validateFactorExpr(manualExpr.trim()); setExprError(r.ok ? "" : (r as { ok: false; error: string }).error); }
  async function add(e: FormEvent) {
    e.preventDefault(); if (!name.trim() || !expr.trim()) return;
    const r = validateFactorExpr(expr.trim()); if (!r.ok) { setExprError((r as { ok: false; error: string }).error); return; }
    const entry: UserStrategy = { id: uid(), name: name.trim(), expr: expr.trim(), direction: dir, holdDays, stopPct: stopPct ? Number(stopPct) : null, targetPct: targetPct ? Number(targetPct) : null, note: note.trim(), source: mode, createdAt: new Date().toISOString().slice(0, 10) };
    const next = [entry, ...list]; setList(next); setSaving(true); await saveStrategies(next); setSaving(false);
    setName(""); setNl(""); setAiExpr(""); setManualExpr(""); setNote(""); setStopPct(""); setTargetPct(""); setExprError(""); setShowForm(false);
  }
  async function remove(id: string) { const next = list.filter((s) => s.id !== id); setList(next); await saveStrategies(next); }
  function tabClass(active: boolean) { return "rounded border px-2 py-1 text-xs transition " + (active ? "border-brand text-fg" : "border-line text-muted hover:text-fg"); }

  const hasSignals = candidates.length > 0 || reviewed.length > 0;

  return (
    <Frame aside="策略竞技场">
      <Panel title="策略竞技场" note="每日信号 + AI 帮写策略。收盘后初筛，竞价后审核，信号全透明——你决定跟不跟。">
        <div className="flex flex-col gap-4 px-3.5 py-2">

          {/* ── 信号区 ── */}
          {hasSignals && (
            <div className="flex flex-col gap-3 rounded border border-line bg-surface2 p-3">
              <SignalCards title="竞价审核后可执行" signals={reviewed} variant="reviewed" />
              <SignalCards title="收盘初筛候选" signals={candidates} variant="candidate" />
            </div>
          )}
          {!hasSignals && (
            <div className="rounded border border-line bg-surface2 p-3 text-center text-xs text-muted">
              今天还没有信号。收盘后脚本自动运行，明天早上来看。
            </div>
          )}

          {/* ── 策略管理区 ── */}
          <div className="flex flex-col gap-2">
            <div>
              <button type="button" onClick={() => setShowForm(!showForm)} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-sm"><Plus size={14} /> 添加策略</button>
            </div>

            {showForm && (
              <form onSubmit={add} className="flex flex-col gap-3 rounded border border-line bg-surface2 p-3">
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => { setMode("ai"); setExprError(""); }} className={tabClass(mode === "ai")}><WandIcon size={12} className="mr-1 inline" />AI 帮写</button>
                  <button type="button" onClick={() => { setMode("manual"); setExprError(""); }} className={tabClass(mode === "manual")}>手工表达式</button>
                </div>
                {mode === "ai" ? (
                  <div className="flex flex-col gap-2">
                    <input type="text" value={nl} onChange={(e) => setNl(e.target.value)} placeholder='用自然语言描述选股思路，如：「跌了两个月缩量止跌」「放量突破上轨」' className="rounded border border-line bg-transparent px-2 py-1.5 text-sm" />
                    <button type="button" onClick={generateExpr} disabled={aiBusy || !nl.trim()} className="self-start inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-xs disabled:opacity-40"><Sparkles size={12} className="text-brand" />{aiBusy ? "AI 思考中…" : "生成表达式"}</button>
                    {aiExpr && <div className="rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg">✅ {aiExpr}</div>}
                    {aiError && <div className="rounded border border-line bg-up/10 px-2 py-1.5 text-xs text-up">{aiError}</div>}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <textarea value={manualExpr} onChange={(e) => { setManualExpr(e.target.value); setExprError(""); }} onBlur={validateManual} placeholder="直接写表达式，如：d60 * -1 - volShrink" rows={2} className="rounded border border-line bg-transparent px-2 py-1.5 font-mono text-xs" />
                    {exprError && <p className="text-xs text-up">{exprError}</p>}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="策略名称" className="flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm" required />
                  <label className="flex items-center gap-1 text-xs text-muted">方向
                    <select value={dir} onChange={(e) => setDir(Number(e.target.value) as 1 | -1)} className="rounded border border-line bg-transparent px-1 py-1 text-xs"><option value={1}>正向</option><option value={-1}>反向</option></select>
                  </label>
                  <label className="flex items-center gap-1 text-xs text-muted">持有<input type="number" value={holdDays} onChange={(e) => setHoldDays(Number(e.target.value) || 5)} className="w-12 rounded border border-line bg-transparent px-1 text-center text-sm" min={1} max={60} />天</label>
                  <label className="flex items-center gap-1 text-xs text-muted">止损<input type="number" value={stopPct} onChange={(e) => setStopPct(e.target.value)} className="w-14 rounded border border-line bg-transparent px-1 text-center text-sm" min={0.5} max={20} step={0.5} />%</label>
                  <label className="flex items-center gap-1 text-xs text-muted">止盈<input type="number" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} className="w-14 rounded border border-line bg-transparent px-1 text-center text-sm" min={1} max={50} step={1} />%</label>
                </div>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选）" className="rounded border border-line bg-transparent px-2 py-1 text-sm" />
                <button type="submit" disabled={saving || !expr.trim() || !name.trim()} className="self-start rounded-full border border-line bg-brand text-white px-3 py-1 text-sm disabled:opacity-40">{saving ? "保存中…" : "保存策略"}</button>
              </form>
            )}

            <div className="flex flex-col gap-2">
              {list.length === 0 && <p className="text-sm text-muted">还没有策略。点「添加策略」。</p>}
              {list.map((s) => (
                <div key={s.id} className="flex flex-col gap-1 rounded border border-line bg-surface p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Swords size={16} className="text-brand" />
                      <span className="font-medium text-sm">{s.name}</span>
                      <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">{s.source === "ai" ? "AI" : "手工"}</span>
                    </div>
                    <button type="button" onClick={() => remove(s.id)} className="text-muted hover:text-up"><Trash2 size={14} /></button>
                  </div>
                  <code className="rounded bg-surface2 px-2 py-0.5 font-mono text-xs text-fg select-all">{s.expr}</code>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span>持有 {s.holdDays} 天</span>
                    {s.stopPct != null && <span>止损 -{s.stopPct}%</span>}
                    {s.targetPct != null && <span>止盈 +{s.targetPct}%</span>}
                    <span>{s.createdAt}</span>
                    {s.note && <span className="w-full text-[11px] opacity-70">📝 {s.note}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>
    </Frame>
  );
}