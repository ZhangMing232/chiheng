/**
 * 策略管理：AI 帮写 + 手工表达式 + 策略列表。
 * 从 /arena 拆出来的子页面。
 */

import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { SectionTabs } from "@/components/section-tabs";
import { Swords, Plus, Trash2, Sparkles, WandIcon } from "lucide-react";
import { expressNaturalLanguage } from "@/lib/market/quotes.functions";
import { validateFactorExpr } from "@/lib/market/factor-expr";

const STRATEGIES_FILE = "data/strategies/user-defined.json";

interface UserStrategy {
  id: string; name: string; expr: string; direction: 1 | -1; holdDays: number;
  stopPct: number | null; targetPct: number | null; note: string; source: "ai" | "manual"; createdAt: string;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

async function saveStrategies(list: UserStrategy[]) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("data/strategies", { recursive: true });
  await writeFile(STRATEGIES_FILE, JSON.stringify(list, null, 2));
}

export const ARANA_TABS = [
  { to: "/arena/signals", label: "每日信号" },
  { to: "/arena/strategies", label: "策略管理" },
  { to: "/arena/tracking", label: "战绩跟踪" },
  { to: "/arena/autopsy", label: "失败归因" },
];

function ArenaStrategies() {
  const { data: strategies = [] } = useQuery({
    queryKey: ["arenaStrategies"],
    queryFn: async () => {
      const { readFile } = await import("node:fs/promises");
      try { const raw = await readFile(STRATEGIES_FILE, "utf8"); return JSON.parse(raw) as UserStrategy[]; } catch { return []; }
    },
    refetchInterval: 120000,
  });
  const [list, setList] = useState<UserStrategy[]>(strategies);

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

  return (
    <Frame aside="策略竞技场">
      <Panel title="策略管理" note="AI 帮写表达式 + 手工输入，保存后可在选股和回测里用。">
        <div className="flex flex-col gap-4 px-4 py-3">
          <SectionTabs tabs={ARANA_TABS} ariaLabel="竞技场子页面" />

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
      </Panel>
    </Frame>
  );
}

export const Route = createFileRoute("/arena/strategies")({ component: ArenaStrategies });