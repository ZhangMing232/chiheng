/**
 * 这个文件是干什么的：
 * 因子页的 6 关判决总表，和点开单因子后的详情（五档形状 + 每关判据原话 + 预注册理由）。
 *
 * 你需要知道的：
 * 1. **没做 / 没记的关渲染成「—」，不是 ✗。** 资金流探路这次没做 G4，2026-10-07 之前的
 *    批次也没落前后两段的判据原话——那是缺数据，不是没通过。补成 ✗ 等于把「不知道」
 *    说成「不及格」，补成 ✓ 更离谱。
 * 2. **未过关的因子一个都不藏。** 落进「未过因子（差 ≥2 关）」折叠区，默认收起但全列出来；
 *    展开后照样 25 个全在，包括只过了 G6 那三个新因子。只展示过关的等于骗人——
 *    现在本来就是「25 个里 0 个全过」，所以默认主表只留「接近过关的」（全过或只差一关）。
 * 3. 五档形状（BucketShape）也被分档明细那块复用，柱高按本行最大绝对值归一，
 *    **不能跨因子比高低**——这是归一化的代价，脚注里写明了。
 */
// Fragment 是必须的：<tr> 里不能直接嵌 <tr>（浏览器会把内层那个提出来当兄弟行，
// 展开的内容就跑到表外面去了）。主行和详情行必须是 tbody 下的两个兄弟 <tr>。
import { Fragment, useState } from "react";
import { Table, tdClass, thClass, pctClass } from "@/components/terminal";
import { signedPct } from "@/lib/market/format";
import { GATE_LEGEND, type FactorRowView } from "@/lib/market/factors-view";

/** 五档平均超额的形状图。左=因子值最低档，右=最高档。 */
export function BucketShape({ means }: { means: number[] }) {
  const scale = Math.max(...means.map((v) => Math.abs(v)), 1e-4);
  return (
    <div>
      <div className="text-xs text-muted">五档平均超额（左=因子值最低档，右=最高档）</div>
      <div className="mt-1.5 flex items-end gap-1.5">
        {means.map((v, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className={`text-xs tabular-nums ${pctClass(v * 100)}`}>{signedPct(v * 100)}</span>
            <span className="flex h-16 w-full items-end">
              <span
                className={`w-full ${v >= 0 ? "bg-up" : "bg-down"}`}
                style={{ height: `${(Math.abs(v) / scale) * 100}%`, minHeight: 2 }}
              />
            </span>
            <span className="text-[11px] text-muted">档{i + 1}</span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-muted">
        柱高按本行最大绝对值归一，只能看这一行内部的形状，不能跨因子比高低。
      </p>
    </div>
  );
}

/** 一关的格子。pass 为 null 时是「—」而不是 ✗。 */
function GateMark({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="text-muted">—</span>;
  return <span className={pass ? "text-fg" : "text-warn"}>{pass ? "✓" : "✗"}</span>;
}

function GateHead() {
  return (
    <thead>
      <tr className="border-b border-line">
        <th className={thClass("text-left")}>因子</th>
        <th data-opt className={thClass("text-left")}>
          类别
        </th>
        <th className={thClass("text-left")}>方向</th>
        {GATE_LEGEND.map((g) => (
          <th key={g.key} className={thClass()} title={g.rule}>
            {g.label}
          </th>
        ))}
        <th className={thClass()}>顶−底</th>
        <th className={thClass()}>t</th>
      </tr>
    </thead>
  );
}

/** 单行（主行 + 点开后的详情行）。isOpen / onToggle 由上层持有，两个表共享一套展开状态。 */
function GateRow({
  row,
  isOpen,
  onToggle,
}: {
  row: FactorRowView;
  isOpen: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Fragment key={row.id}>
      <tr className="border-b border-line last:border-b-0">
        <td data-l="因子" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={`factor-detail-${row.id}`}
            onClick={() => onToggle(row.id)}
            className="text-left font-medium hover:text-muted"
          >
            {isOpen ? "▾ " : "▸ "}
            {row.name}
          </button>
          <div className="text-[11px] text-muted">
            {row.passed}/{row.total} 关
            {row.allPass ? " · 全过" : ""}
          </div>
        </td>
        <td data-l="类别" data-opt className={tdClass("text-left text-muted")}>
          {row.category}
        </td>
        <td data-l="方向" className={tdClass("text-left text-muted")}>
          {row.direction > 0 ? "正向" : "反向"}
        </td>
        {row.gates.map((gate) => (
          <td key={gate.key} data-l={GATE_LEGEND.find((g) => g.key === gate.key)?.label} className={tdClass()}>
            <GateMark pass={gate.pass} />
          </td>
        ))}
        <td data-l="顶−底" className={tdClass(pctClass(row.spread * 100))}>
          {signedPct(row.spread * 100)}
        </td>
        <td data-l="t" className={tdClass("font-medium")}>
          {row.t.toFixed(2)}
        </td>
      </tr>
      {isOpen ? (
        <tr data-detail id={`factor-detail-${row.id}`} className="border-b border-line">
          <td colSpan={11} data-l="详情" className="px-3 py-3 text-left align-top">
            <BucketShape means={row.bucketMeans} />
            <dl className="mt-3 grid gap-1">
              {row.gates.map((gate) => {
                const legend = GATE_LEGEND.find((g) => g.key === gate.key);
                return (
                  <div key={gate.key} className="flex gap-2 text-xs">
                    <span className="w-6 shrink-0 text-muted">{gate.key.toUpperCase()}</span>
                    <span className="w-4 shrink-0">
                      <GateMark pass={gate.pass} />
                    </span>
                    <span className="text-muted">{gate.detail}</span>
                    {legend ? <span className="hidden text-muted md:inline">· {legend.rule}</span> : null}
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 text-[11px] text-muted">
              预注册理由（跑之前写下的，跑完不许改）：
              {row.rationaleMissing
                ? " factors.ts 里查不到这个因子，说明它是旧批次跑的，理由没留下来。"
                : ` ${row.rationale}`}
            </p>
            <p className="mt-1 text-[11px] text-muted">有效交易日 {row.nDays} 天。</p>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export function FactorGateTable({ rows }: { rows: FactorRowView[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // 接近过关的（全过 / 只差一关）留主表；差 ≥2 关的归到下方折叠区，默认收起。
  // 不隐藏——展开后照样全列，守「未过关一个都不藏」。
  const focused = rows.filter((r) => r.allPass || r.passed >= r.total - 1);
  const buried = rows.filter((r) => !(r.allPass || r.passed >= r.total - 1));
  const [showBuried, setShowBuried] = useState(false);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Table
        className="data-table"
        caption="因子 6 关判决总表：接近过关的（全过或只差一关）留主表，差 ≥2 关的收进下方折叠区；点因子名展开判据原话与预注册理由"
      >
        <GateHead />
        <tbody>
          {focused.map((row) => (
            <GateRow key={row.id} row={row} isOpen={open.has(row.id)} onToggle={toggle} />
          ))}
          {focused.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-3 py-3 text-center text-sm text-muted">
                这一批没有接近过关的因子（全过或只差一关的都没有）
              </td>
            </tr>
          ) : null}
        </tbody>
      </Table>

      {buried.length > 0 ? (
        <div className="rounded border border-line bg-surface">
          <button
            type="button"
            onClick={() => setShowBuried((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-sm text-muted transition hover:text-fg"
            aria-expanded={showBuried}
          >
            <span>
              未过因子（差 ≥2 关）
              <span className="ml-1 tabular-nums text-muted">{buried.length}</span> 个
            </span>
            <span className="shrink-0">{showBuried ? "收起 ▲" : "展开 ▼"}</span>
          </button>
          {showBuried ? (
            <Table className="data-table" caption="未过因子（差 ≥2 关），展开后全列出来">
              <GateHead />
              <tbody>
                {buried.map((row) => (
                  <GateRow key={row.id} row={row} isOpen={open.has(row.id)} onToggle={toggle} />
                ))}
              </tbody>
            </Table>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
