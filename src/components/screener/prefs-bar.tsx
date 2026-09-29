import type { Prefs } from "@/lib/market/prefs";
import { STYLES } from "@/lib/market/strategies";

const BOARDS: { id: Prefs["board"]; label: string }[] = [
  { id: "all", label: "不限" },
  { id: "main", label: "沪深主板" },
  { id: "cyb", label: "创业板" },
  { id: "kcb", label: "科创板" },
];

const PRICES: { id: Prefs["price"]; label: string }[] = [
  { id: "all", label: "不限" },
  { id: "low", label: "10元以下" },
  { id: "mid", label: "10到30元" },
  { id: "high", label: "30元以上" },
];

const CAPS: { id: Prefs["cap"]; label: string }[] = [
  { id: "all", label: "不限" },
  { id: "small", label: "100亿以下" },
  { id: "mid", label: "100到500亿" },
  { id: "large", label: "500亿以上" },
];

function Row<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onPick: (id: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="w-14 shrink-0 text-sm text-muted">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onPick(option.id)}
            className={
              "h-10 rounded-full px-3 text-sm " +
              (value === option.id ? "bg-fg text-bg" : "bg-surface-2 text-fg")
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PrefsBar({ prefs, onChange }: { prefs: Prefs; onChange: (next: Prefs) => void }) {
  return (
    <section className="rounded-2xl border border-line bg-surface px-5 py-4 shadow-card">
      <h2 className="font-serif text-lg font-semibold">策略和范围</h2>
      <p className="mt-1 text-sm text-muted">先选策略。买入价和卖出价按这套策略算，每只股票不一样。打到买入价才记账。</p>
      <div className="mt-3 flex flex-col gap-3">
        <Row label="策略" value={prefs.style} options={STYLES.map((item) => ({ id: item.id, label: item.name }))} onPick={(style) => onChange({ ...prefs, style })} />
        <p className="text-sm text-muted">{STYLES.find((item) => item.id === prefs.style)?.hint}</p>
        <Row label="板块" value={prefs.board} options={BOARDS} onPick={(board) => onChange({ ...prefs, board })} />
        <Row label="股价" value={prefs.price} options={PRICES} onPick={(price) => onChange({ ...prefs, price })} />
        <Row label="市值" value={prefs.cap} options={CAPS} onPick={(cap) => onChange({ ...prefs, cap })} />
      </div>
    </section>
  );
}
