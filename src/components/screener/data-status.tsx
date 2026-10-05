/**
 * 这个文件是干什么的：
 * 选股页顶上的状态徽标。平时不占地方；有问题时只说结论，点开才说原因——
 * 而且原因必须答完三问：为什么、影响什么、什么时候恢复，末尾给一个真能解决问题的按钮。
 *
 * 你需要知道的：
 * 这个结构来自 tick-stock-panel 的 SealedBadge，抄的是思路不是代码。
 * 它修的是一个真实的坑：主源降级那天页面只显示「这套策略现在没有符合的股票」，
 * 看着像当天没机会，实际是数据源缺字段。那天靠翻日志才定位到，白花了几个小时。
 *
 * 差别在于：光说「哪个源、多久前」不够。用户要的是三件事——为什么会这样、
 * 今天还能不能操作、什么时候会自己好。少答一条就等于没说清，所以做成硬结构
 * （见 lib/market/data-status.ts 的 Notice），并由测试钉住。
 *
 * 账本那条（AccountStatus）是同一天发现的第二例：服务端账本读不到时，
 * catch 里悄悄返回空数组，页面摆一个全零账本，看着像数据丢了。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { snapshotAge } from "@/lib/market/format";
import { accountNotice, noticeOf, sourceLabel, type Notice } from "@/lib/market/data-status";
import type { Universe } from "@/lib/market/types";

const TONE_CLASS = {
  warn: "border-warn bg-warn-soft text-warn",
  info: "border-line text-muted",
} as const;

const DOT_CLASS = { warn: "bg-warn", info: "bg-muted" } as const;

const POPOVER_W = 300;
const POPOVER_H = 260;

/**
 * 一个可点的状态徽标 + 点开的三问浮层。行情和账本共用它。
 *
 * 浮层用 createPortal 挂到 body：父级有 overflow-hidden 会被裁掉，
 * 而父级有 transform / filter / backdrop-filter 时 fixed 又会变成它的包含块，
 * 两条路都走不通，portal 是唯一稳的。下方空间不够就翻到徽标上方。
 */
function StatusPill({
  notice,
  onAction,
  actionLabel,
  actionBusy,
}: {
  notice: Notice;
  onAction?: () => void;
  actionLabel?: string;
  actionBusy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  // portal 要 document.body，SSR 阶段没有 document，所以挂载之后才渲染浮层
  useEffect(() => setMounted(true), []);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open && btn.current) {
            const r = btn.current.getBoundingClientRect();
            const top =
              r.bottom + POPOVER_H > window.innerHeight
                ? Math.max(8, r.top - POPOVER_H - 4)
                : r.bottom + 4;
            setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W - 8)), top });
          }
          setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1 rounded-full border bg-surface px-2 py-0.5 text-xs cursor-help ${TONE_CLASS[notice.tone]}`}
      >
        <span className={`size-1.5 rounded-full ${DOT_CLASS[notice.tone]}`} aria-hidden />
        {notice.label}
        <span aria-hidden>？</span>
      </button>

      {mounted && open && pos
        ? createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div
                style={{ position: "fixed", left: pos.left, top: pos.top, width: POPOVER_W, zIndex: 50 }}
                className="rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed shadow-pop"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-2 font-medium text-fg">这个提示什么意思</div>
                {(
                  [
                    ["为什么", notice.why],
                    ["影响", notice.impact],
                    ["什么时候恢复", notice.recovery],
                  ] as const
                ).map(([label, body]) => (
                  <div key={label} className="mb-1.5 flex gap-1.5">
                    <span className="shrink-0 text-muted">{label}</span>
                    <span className="text-muted">{body}</span>
                  </div>
                ))}
                <div className="mt-2.5 flex gap-1.5 border-t border-line pt-2.5">
                  {onAction ? (
                    <button
                      type="button"
                      onClick={() => {
                        onAction();
                        setOpen(false);
                      }}
                      disabled={actionBusy}
                      className="rounded border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      {actionBusy ? "正在拉…" : (actionLabel ?? "重新拉一次")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded border border-line px-2 py-1 text-muted hover:bg-surface-2"
                  >
                    知道了
                  </button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

/** 行情状态：平时显示「腾讯 · 3 分钟前」，降级/过期/残缺时多一个可点的徽标。 */
export function DataStatusBadge({
  universe,
  now,
  onRefresh,
  refreshing,
}: {
  universe: Universe | null | undefined;
  now: number;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  if (!universe || universe.quotes.length === 0) {
    return <span className="text-muted">行情还没拉下来，正在重试…</span>;
  }
  const notice = noticeOf(universe, now);
  const age = `${sourceLabel(universe.source)} · ${snapshotAge(now - universe.asOf)}`;

  if (!notice) {
    return (
      <span className="text-muted">
        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-up align-middle" aria-hidden />
        {age}
      </span>
    );
  }
  return (
    <>
      <StatusPill notice={notice} onAction={onRefresh} actionBusy={refreshing} />
      <span className="text-muted">{age}</span>
    </>
  );
}

/** 账本状态：读不到服务端账本时明确说「这是空账」，别让全零的页面冒充真实。 */
export function AccountStatus({ personal, why }: { personal: boolean; why: string | null | undefined }) {
  const notice = accountNotice(personal, why);
  if (!notice) return null;
  return <StatusPill notice={notice} />;
}
