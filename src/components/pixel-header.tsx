/**
 * 像素终端标题块（2026-11-12）。
 *
 * 为什么抽出来：`/today` 和 `/watch` 各自写了一份「斜切标签 + 虚线 + 右侧口径说明 +
 * 红青警戒斜纹」，再往其余页面复制就会走形。这里做成一处，所有工作台引用同一个。
 *
 * 只放装饰和口径文字，不承载数据——数据由各页自己的 aside/status 负责，
 * 免得出现两处都声称「现在是几点几分」的第二个真相。
 */
export function PixelHeader({
  label,
  meta,
  children,
}: {
  /** 斜切标签，惯例是全大写英文 + 下划线，比如 BUY_MATRIX / WATCH // LADDER */
  label: string;
  /** 右侧口径说明：这页的数字是实时的还是收盘的、从哪来的 */
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="px-slash">{label}</span>
        <span className="h-px flex-1 bg-line" />
        {meta ? <span className="px-num text-[12px] text-muted">{meta}</span> : null}
      </div>
      <div className="px-hazard" aria-hidden="true" />
      {children}
    </div>
  );
}
