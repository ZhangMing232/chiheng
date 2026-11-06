/**
 * 这个文件是干什么的：
 * 一条「提示横幅」：信息 / 警告 / 成功 / 中性。效果图上「1 处数据缺口 →查看缺口」、
 * 「仅供查看·追踪已暂停」那种带 CTA 的条就是它。全站统一一处，别再各页手写零散文案。
 *
 * 你需要知道的：
 * - 颜色只走 token（accent / warn / down / muted），不写死——深浅主题自动跟随，
 *   也绝不碰现有的青色配色（用户拍板不动颜色）。
 * - tone 语义对齐全站约定（和 status-widgets / 参考实现 README §3 同套）：
 *     info    信息 / 链接 / 进行中        → accent（品牌青）
 *     warning 缺口 / 待确认 / 不完整 / 风险 → warn（琥珀）
 *     success 通过 / 正常 / 已落账         → down（绿）
 *     neutral 历史 / 禁用 / 暂无           → muted（灰）
 * - action 是「真能解决问题的操作」：{ label, href } 渲染成链接，{ label, onClick }
 *   渲染成按钮。没有就不给——别为了好看塞个假按钮。
 */

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Minus, type LucideIcon } from "lucide-react";

export type CalloutTone = "info" | "warning" | "success" | "neutral";

const TONE: Record<CalloutTone, { wrap: string; Icon: LucideIcon }> = {
  info: { wrap: "border-accent/50 bg-accent-soft text-accent", Icon: Info },
  warning: { wrap: "border-warn/50 bg-warn-soft text-warn", Icon: AlertTriangle },
  success: { wrap: "border-down/50 bg-down-soft text-down", Icon: CheckCircle2 },
  neutral: { wrap: "border-line bg-surface-2 text-muted", Icon: Minus },
};

export function Callout({
  tone = "info",
  title,
  detail,
  action,
  className = "",
}: {
  tone?: CalloutTone;
  /** 主文案（粗一点）。写具体，别写「注意」。 */
  title: ReactNode;
  /** 次行：为什么、影响、接下来怎么办。可省。 */
  detail?: ReactNode;
  /** 一个真正的操作：{ label, href } 渲染成链接；{ label, onClick } 渲染成按钮。 */
  action?: { label: string; onClick?: () => void; href?: string };
  className?: string;
}) {
  const t = TONE[tone];
  const Icon = t.Icon;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded border px-3 py-2 text-xs leading-relaxed ${t.wrap} ${className}`}
    >
      <Icon className="mt-px size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {detail ? <div className="mt-0.5 opacity-90">{detail}</div> : null}
      </div>
      {action ? (
        action.href ? (
          <a href={action.href} className="shrink-0 self-center font-medium underline underline-offset-2 hover:opacity-80">
            {action.label}
          </a>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="shrink-0 self-center font-medium underline underline-offset-2 hover:opacity-80"
          >
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}
