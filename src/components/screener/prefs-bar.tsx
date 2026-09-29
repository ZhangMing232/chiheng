import type { Prefs } from "@/lib/market/prefs";

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
      <h2 className="font-serif text-lg font-semibold">选股偏好</h2>
      <p className="mt-1 text-sm text-muted">先选板块、股价和市值。精选按这个范围出，之后锁定的名单也按这个范围。</p>
      <div className="mt-3 flex flex-col gap-3">
        <Row label="板块" value={prefs.board} options={BOARDS} onPick={(board) => onChange({ ...prefs, board })} />
        <Row label="股价" value={prefs.price} options={PRICES} onPick={(price) => onChange({ ...prefs, price })} />
        <Row label="市值" value={prefs.cap} options={CAPS} onPick={(cap) => onChange({ ...prefs, cap })} />
      </div>
    </section>
  );
}
