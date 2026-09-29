/**
 * 这个文件是干什么的：
 * 选股页里可展开的「筛选范围」。按板块、股价、市值三行按钮缩小名单。
 *
 * 你需要知道的：
 * 只影响名单里出现谁。五套策略的账仍然分开记，每套最多 10 只。
 */

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

/** 三行筛选。点板块、股价或市值，把新的偏好交回给选股页去保存。 */
export function PrefsBar({ prefs, onChange }: { prefs: Prefs; onChange: (next: Prefs) => void }) {
  return (
    <details className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-card">
      <summary className="cursor-pointer text-sm font-medium">筛选范围</summary>
      <p className="mt-2 text-xs text-muted">只影响名单里出现谁。五套的账仍然分开记，每套最多 10 只。</p>
      <div className="mt-3 flex flex-col gap-3 pb-1">
        <Row label="板块" value={prefs.board} options={BOARDS} onPick={(board) => onChange({ ...prefs, board })} />
        <Row label="股价" value={prefs.price} options={PRICES} onPick={(price) => onChange({ ...prefs, price })} />
        <Row label="市值" value={prefs.cap} options={CAPS} onPick={(cap) => onChange({ ...prefs, cap })} />
      </div>
    </details>
  );
}
