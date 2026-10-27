/**
 * 这个文件是干什么的：
 * 「策略竞技场」页（/arena）——路线C：手工定义选股条件，系统跑回测验证，所有策略并列展示。
 * 不是 AI 自动选冠军，是人机协作：你看回测数据自己决定信哪个。
 *
 * 你需要知道的：
 * - 策略数据存 data/strategies/user-defined.json（JSON 数组）。
 * - 回测目前走命令行：npm run backtest -- --strategy=策略id。
 * - 样本数少是预期内的——策略门槛刚从 30 降到 15 笔。
 */

import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { Swords, Plus, Trash2, Play, X } from "lucide-react";

const STRATEGIES_FILE = "data/strategies/user-defined.json";

type StrategyType = "breakout" | "reversal" | "custom";

interface UserStrategy {
  id: string;
  name: string;
  type: StrategyType;
  holdDays: number;
  stopPct: number | null;
  targetPct: number | null;
  note: string;
  createdAt: string;
}

const TYPE_LABELS: Record<StrategyType, string> = {
  breakout: "放量突破",
  reversal: "中期反转",
  custom: "自定义条件",
};

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const Route = createFileRoute("/arena")({
  loader: async () => {
    let strategies: UserStrategy[] = [];
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(STRATEGIES_FILE, "utf8");
      strategies = JSON.parse(raw);
      if (!Array.isArray(strategies)) strategies = [];
    } catch {
      strategies = [];
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

function ArenaPage() {
  const { strategies: initial } = Route.useLoaderData();
  const [list, setList] = useState<UserStrategy[]>(initial);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<StrategyType>("breakout");
  const [holdDays, setHoldDays] = useState(5);
  const [stopPct, setStopPct] = useState("");
  const [targetPct, setTargetPct] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const entry: UserStrategy = {
      id: uid(),
      name: name.trim(),
      type,
      holdDays,
      stopPct: stopPct ? Number(stopPct) : null,
      targetPct: targetPct ? Number(targetPct) : null,
      note: note.trim(),
      createdAt: new Date().toISOString().slice(0, 10),
    };
    const next = [entry, ...list];
    setList(next);
    setSaving(true);
    await saveStrategies(next);
    setSaving(false);
    setName("");
    setNote("");
    setStopPct("");
    setTargetPct("");
    setShowForm(false);
  }

  async function remove(id: string) {
    const next = list.filter((s) => s.id !== id);
    setList(next);
    await saveStrategies(next);
  }

  function backtestCmd(id: string) {
    return `npm run backtest -- --strategy=${id}`;
  }

  return (
    <Frame aside="策略竞技场">
      <Panel
        title="策略竞技场"
        note="手工定义选股条件，系统跑回测验证，所有策略并列展示——你决定信哪个。"
      >
        <div className="flex flex-col gap-3 px-3.5 py-2">
          {/* 添加按钮 */}
          <div>
            <button
              type="button"
              onClick={() => setShowForm(!showForm)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-sm"
            >
              {showForm ? <X size={14} /> : <Plus size={14} />}
              {showForm ? "取消" : "添加策略"}
            </button>
          </div>

          {/* 添加表单 */}
          {showForm && (
            <form onSubmit={add} className="flex flex-col gap-2 rounded border border-line bg-surface2 p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="策略名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="flex-1 rounded border border-line bg-transparent px-2 py-1 text-sm"
                  required
                />
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as StrategyType)}
                  className="rounded border border-line bg-transparent px-2 py-1 text-sm"
                >
                  {(["breakout", "reversal", "custom"] as const).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 text-sm text-muted">
                <label className="flex items-center gap-1">
                  持有
                  <input type="number" value={holdDays} onChange={(e) => setHoldDays(Number(e.target.value) || 5)} className="w-12 rounded border border-line bg-transparent px-1 text-center text-sm" min={1} max={60} />
                  天
                </label>
                <label className="flex items-center gap-1">
                  止损
                  <input type="number" value={stopPct} onChange={(e) => setStopPct(e.target.value)} className="w-16 rounded border border-line bg-transparent px-1 text-center text-sm" min={0.5} max={20} step={0.5} placeholder="%" />
                  %
                </label>
                <label className="flex items-center gap-1">
                  止盈
                  <input type="number" value={targetPct} onChange={(e) => setTargetPct(e.target.value)} className="w-16 rounded border border-line bg-transparent px-1 text-center text-sm" min={1} max={50} step={1} placeholder="%" />
                  %
                </label>
              </div>
              <input
                type="text"
                placeholder="备注（选股逻辑简述）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded border border-line bg-transparent px-2 py-1 text-sm"
              />
              <button type="submit" disabled={saving} className="self-start rounded-full border border-line bg-brand text-white px-3 py-1 text-sm disabled:opacity-50">
                {saving ? "保存中…" : "添加到竞技场"}
              </button>
            </form>
          )}

          {/* 策略列表 */}
          <div className="flex flex-col gap-2">
            {list.length === 0 && (
              <p className="text-sm text-muted">还没有策略。点「添加策略」创建第一条，然后跑回测看效果。</p>
            )}
            {list.map((s) => (
              <div key={s.id} className="flex flex-col gap-1 rounded border border-line bg-surface p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Swords size={16} className="text-brand" />
                    <span className="font-medium text-sm">{s.name}</span>
                    <span className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] text-muted">{TYPE_LABELS[s.type]}</span>
                  </div>
                  <button type="button" onClick={() => remove(s.id)} className="text-muted hover:text-up" title="删除">
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>持有 {s.holdDays} 天</span>
                  {s.stopPct != null && <span>止损 -{s.stopPct}%</span>}
                  {s.targetPct != null && <span>止盈 +{s.targetPct}%</span>}
                  <span>创建 {s.createdAt}</span>
                  {s.note && <span className="w-full text-[11px] opacity-70">📝 {s.note}</span>}
                </div>
                <div className="mt-1 rounded bg-surface2 px-2 py-1 text-[11px] text-muted font-mono">
                  回测：
                  <code className="ml-1 select-all">{backtestCmd(s.id)}</code>
                </div>
              </div>
            ))}
          </div>

          {/* s */}
        </div>
      </Panel>
    </Frame>
  );
}