/**
 * 这个文件是干什么的：
 * 页面上一块「现在是什么情况」的统一说法。加载中、出错、没数据，都走它。
 *
 * 你需要知道的：
 * 以前每个地方自己写一句话，写出来的东西彼此不一致——有的带图有的不带，
 * 有的说「暂无数据」有的说「没有符合的股票」，看的人得自己猜哪个是严重哪个不严重。
 * 现在规矩定成四条（就绪 / 加载中 / 空 / 降级），每条都必须说清三件事：
 * 发生了什么、影响什么、接下来怎么办。
 *
 * 规矩来自 tick-stock-panel 的 EmptyState 上面那行注释：
 * 「四态评审 — empty 状态：图示 + 引导，而不是一句『暂无数据』」。
 * 那是它的原话，这里照这个方向做。
 */

export type StateKind = "loading" | "empty" | "error";

const TONE: Record<StateKind, string> = {
  loading: "text-muted",
  empty: "text-muted",
  error: "text-warn",
};

const TITLE: Record<StateKind, string> = {
  loading: "正在拉取",
  empty: "这里现在是空的",
  error: "出了点问题",
};

/** 一个 8px 的方块当图示，不引第三方图标库。 */
function Glyph({ kind }: { kind: StateKind }) {
  if (kind === "loading") {
    return (
      <span
        aria-hidden
        className="inline-block size-3 rounded-full border-2 border-current border-t-transparent align-middle motion-safe:animate-spin"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`inline-block size-3 rounded-[3px] border align-middle ${TONE[kind]}`}
    />
  );
}

export function StateBlock({
  kind,
  title,
  hint,
  action,
}: {
  kind: StateKind;
  /** 覆盖默认标题。写具体点，别写「出错了」这种。 */
  title?: string;
  /** 影响 + 接下来怎么办。这是关键，别省。 */
  hint?: string;
  /** 能真的解决问题的操作，比如「重新拉一次」。 */
  action?: { label: string; onClick: () => void; busy?: boolean };
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className={`flex items-center gap-2 text-sm ${TONE[kind]}`}>
        <Glyph kind={kind} />
        <span className="font-medium">{title ?? TITLE[kind]}</span>
      </div>
      {hint ? <p className="max-w-md text-xs leading-relaxed text-muted">{hint}</p> : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.busy}
          className="mt-1 rounded border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 disabled:opacity-50"
        >
          {action.busy ? "正在拉…" : action.label}
        </button>
      ) : null}
    </div>
  );
}
