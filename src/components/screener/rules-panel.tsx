import { useEffect, useState } from "react";
import { saveRules } from "@/lib/market/quotes.functions";
import type { EarlyRules } from "@/lib/market/rules";

const field = "h-11 w-full rounded-md border border-line bg-bg px-3 text-sm";

function Range({
  label,
  min,
  max,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  onChange: (min: number, max: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="grid grid-cols-2 gap-2">
        <input className={field} inputMode="decimal" value={min} onChange={(event) => onChange(Number(event.target.value), max)} />
        <input className={field} inputMode="decimal" value={max} onChange={(event) => onChange(min, Number(event.target.value))} />
      </div>
    </div>
  );
}

export function RulesPanel({ rules, onSaved }: { rules: EarlyRules; onSaved: (next: EarlyRules) => void }) {
  const [draft, setDraft] = useState(rules);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(rules);
  }, [rules]);

  function patch(partial: Partial<EarlyRules>) {
    setDraft((prev) => ({ ...prev, ...partial }));
  }

  async function save() {
    setSaving(true);
    setNote("");
    try {
      const next = await saveRules({ data: draft });
      onSaved(next);
      setNote(next.version === rules.version ? "已保存。" : `已换成第 ${next.version} 版。旧记录还在，但不再计入这一版的真钱开关。今天若已锁定，新规则从下一笔未锁定的记录开始。`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "没保存成");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="mt-3 max-w-3xl rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">规则 · 第 {rules.version} 版</summary>
      <p className="mt-2 text-pretty text-muted">可以改。左边是下限，右边是上限。成交额单位是万元。改筛选会让真钱计数只认新版本。</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Range label="今日涨幅 %" min={draft.chgMin} max={draft.chgMax} onChange={(min, max) => patch({ chgMin: min, chgMax: max })} />
        <Range label="5 日 %" min={draft.d5Min} max={draft.d5Max} onChange={(min, max) => patch({ d5Min: min, d5Max: max })} />
        <Range label="20 日 %" min={draft.d20Min} max={draft.d20Max} onChange={(min, max) => patch({ d20Min: min, d20Max: max })} />
        <Range label="60 日 %" min={draft.d60Min} max={draft.d60Max} onChange={(min, max) => patch({ d60Min: min, d60Max: max })} />
        <Range label="量比" min={draft.volMin} max={draft.volMax} onChange={(min, max) => patch({ volMin: min, volMax: max })} />
        <Range label="换手 %" min={draft.turnMin} max={draft.turnMax} onChange={(min, max) => patch({ turnMin: min, turnMax: max })} />
        <label>
          <span className="mb-1 block text-xs text-muted">成交额至少（万元）</span>
          <input className={field} inputMode="numeric" value={draft.amountMin} onChange={(event) => patch({ amountMin: Number(event.target.value) })} />
        </label>
        <label>
          <span className="mb-1 block text-xs text-muted">真钱：记录天数 / 闭环笔数，填 0 就是关掉检验</span>
          <div className="grid grid-cols-2 gap-2">
            <input className={field} inputMode="numeric" value={draft.minDays} onChange={(event) => patch({ minDays: Number(event.target.value) })} />
            <input className={field} inputMode="numeric" value={draft.minClosed} onChange={(event) => patch({ minClosed: Number(event.target.value) })} />
          </div>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" className="h-11 rounded-md bg-fg px-4 text-bg disabled:opacity-60" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中" : "保存规则"}
        </button>
        {note ? <p className="text-pretty text-muted">{note}</p> : null}
      </div>
    </details>
  );
}
