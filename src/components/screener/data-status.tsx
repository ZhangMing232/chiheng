/**
 * 这个文件是干什么的：
 * 选股页顶上的「行情状态」徽标。平时一句话都不占；有问题时只说结论，
 * 点开才说原因——而且原因必须答完三问：为什么降级、影响什么、什么时候恢复，
 * 末尾给一个能真的解决问题的按钮。
 *
 * 你需要知道的：
 * 这个结构是从 tick-stock-panel 的 SealedBadge 抄来的思路，不是抄代码。
 * 那边踩过的坑很具体：主源降级那天，页面只显示「这套策略现在没有符合的股票」，
 * 看着像今天没机会，实际是数据源缺字段。那天靠翻日志才定位到，白花了几个小时。
 *
 * 区别在于：光说「哪个源、多久前」是不够的。用户真正想知道的是三件事——
 * 为什么会这样、今天还能不能操作、什么时候会自己好。少答一条就等于没说清。
 * 所以这里把三问做成硬结构（Notice 里的三个字段），不是散在一句话里。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { snapshotAge } from "@/lib/market/format";
import { noticeOf, sourceLabel } from "@/lib/market/data-status";
import type { Universe } from "@/lib/market/types";

const TONE_CLASS = {
  warn: "border-[color-mix(in_srgb,var(--color-down)_45%,transparent)] text-down",
  info: "border-line text-muted",
} as const;

const DOT_CLASS = { warn: "bg-down", info: "bg-muted" } as const;

function ageText(universe: Universe, now: number): string {
  return `${sourceLabel(universe.source)} · ${snapshotAge(now - universe.asOf)}`;
}

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
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  // portal 要 document.body，SSR 阶段没有 document，所以挂载之后才渲染浮层
  useEffect(() => setMounted(true), []);

  if (!universe || universe.quotes.length === 0) {
    return <span className="text-muted">行情还没拉下来，正在重试…</span>;
  }
  const notice = noticeOf(universe);

  // 平时只显示一行「腾讯 · 3 分钟前」，有问题时多一个可点的徽标
  if (!notice) {
    return (
      <span className="text-muted">
        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-up align-middle" aria-hidden />
        {ageText(universe, now)}
      </span>
    );
  }

  const W = 300;
  const H = 260;
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open && btn.current) {
            // 浮层用 fixed 定位，父级 overflow-hidden 裁不到；但父级有 transform / filter /
            // backdrop-filter 就会变成它的包含块，所以还是走 portal 稳妥。
            // 下方空间不够就翻到徽标上方。
            const r = btn.current.getBoundingClientRect();
            const top = r.bottom + H > window.innerHeight ? Math.max(8, r.top - H - 4) : r.bottom + 4;
            setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)), top });
          }
          setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1 rounded-full border bg-surface px-2 py-0.5 text-xs cursor-help ${TONE_CLASS[notice.tone]}`}
      >
        <span className={`size-1.5 rounded-full ${DOT_CLASS[notice.tone]}`} aria-hidden />
        {notice.label}
        <span aria-hidden>？</span>
      </button>
      <span className="text-muted">{ageText(universe, now)}</span>

      {mounted && open && pos
        ? createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div
                style={{ position: "fixed", left: pos.left, top: pos.top, width: W, zIndex: 50 }}
                className="rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-2 font-medium text-fg">{notice.label}了什么</div>
                {(
                  [
                    ["为什么", notice.why, "var(--color-text-secondary)"],
                    ["影响", notice.impact, "var(--color-text-secondary)"],
                    ["什么时候恢复", notice.recovery, "var(--color-text-secondary)"],
                  ] as const
                ).map(([label, body]) => (
                  <div key={label} className="mb-1.5 flex gap-1.5">
                    <span className="shrink-0 text-muted">{label}</span>
                    <span style={{ color: "var(--color-text-secondary)" }}>{body}</span>
                  </div>
                ))}
                <div className="mt-2.5 flex gap-1.5 border-t border-line pt-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      onRefresh();
                      setOpen(false);
                    }}
                    disabled={refreshing}
                    className="rounded border border-line px-2 py-1 hover:bg-surface-2 disabled:opacity-50"
                  >
                    {refreshing ? "正在拉…" : "重新拉一次"}
                  </button>
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
