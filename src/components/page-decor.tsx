/**
 * 这个文件是干什么的：
 * 页面装饰的三层渲染件。配合 lib/ui/page-decor.ts 的配置表用。
 *
 * 三层：
 * - **L1 底纹**（DecorBackdrop）：功能组色相的极淡氛围，铺在内容区顶部。
 *   透明度极低（8%~14% 的渐变），只是让"这一组的页面"和"那一组"有微差。
 * - **L2 页头**（DecorHeader）：图标 + 页面名 + 一句话职能 + 状态药丸。
 *   这是最有价值的一层——进页面 1 秒知道自己在哪、在干什么。
 * - **L3 专属件**（DecorOrnament）：按页面核心概念给的独有装饰。
 *   只有配置表里写了 ornament 的页面才有，不硬凑。
 *
 * 口径纪律：状态药丸的数字**必须来自页面 loader 的真实数据**。
 * 组件本身不拉任何数据——它只渲染传进来的东西。
 */

import type { ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  GitBranch,
  Scale,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  decorFor,
  HUE_COLORS,
  type DecorHue,
  type OrnamentKind,
  type PageDecor,
  type PageStatus,
} from "@/lib/ui/page-decor";

/**
 * L1 底纹。
 *
 * 用 radial-gradient 铺在内容区顶部，两团色（主色相 + 一点点辅色），
 * 透明度低到几乎看不见——但去掉它，整站所有页面会像同一张纸。
 *
 * 深浅色各一套（HUE_COLORS 里存了两套），跟随 html[data-theme]。
 */
export function DecorBackdrop({ hue }: { hue: DecorHue }) {
  const c = HUE_COLORS[hue];
  return (
    <div aria-hidden className="decor-backdrop">
      <style>{`
        .decor-backdrop {
          position: absolute;
          inset: 0 0 auto 0;
          height: 200px;
          pointer-events: none;
          z-index: 0;
          /* 透明度刻意压得很低（7% / 4%）。第一版用 16% / 9% 渲染出来一看，
             五个组像五套不同主题（实拍验证）——底纹是氛围，不是配色方案。
             降到 7% 之后只留一点色温差异，不抢内容。 */
          background:
            radial-gradient(120% 100% at 12% 0%, color-mix(in srgb, var(--decor-hue) 7%, transparent) 0%, transparent 58%),
            radial-gradient(90% 80% at 88% 8%, color-mix(in srgb, var(--decor-hue) 4%, transparent) 0%, transparent 54%);
        }
        :root { --decor-hue: ${c.dark}; }
        html[data-theme="light"] { --decor-hue: ${c.light}; }
        @media (prefers-color-scheme: light) {
          html:not([data-theme]) { --decor-hue: ${c.light}; }
        }
      `}</style>
    </div>
  );
}

/** 状态药丸的色调 → class。涨跌色不能占用（up/down 是行情的）。 */
function toneClass(tone: PageStatus["tone"]): string {
  if (tone === "ok") return "text-down border-down/40 bg-down-soft";
  if (tone === "warn") return "text-warn border-warn/40 bg-warn-soft";
  if (tone === "brand") return "text-brand-text border-brand/40 bg-brand-soft";
  return "text-muted border-line bg-surface-2";
}

/**
 * L2 页头。
 *
 * 结构：图标块 + 页面名 + 一句话职能（+ 可选状态药丸）。
 *
 * **页面名从哪来**：从导航表里取，不在这里写第二份——写两份就会对不上。
 * 职能句来自 page-decor 配置表。
 */
export function DecorHeader({
  decor,
  status,
  actions,
}: {
  /** 装饰配置。null 时整个页头不渲染。
      **标题从 decor.title 取**（配置表是权威来源）——不依赖侧栏导航表：
      有几个页面没有侧栏入口，靠 navHit 取标题会拿到空字符串，页头成空壳。 */
  decor: PageDecor | null;
  /** 状态药丸。页面 loader 算出来的真实状态 */
  status?: PageStatus | null;
  /** 右侧操作区（页面自己的按钮） */
  actions?: ReactNode;
}) {
  if (!decor) return null;
  const Icon = decor.icon;
  const pill = status && status.value != null ? status : null;
  return (
    <div className="relative z-[1] px-0.5 pt-1 pb-0.5">
      {/* 第一行：图标 + 页面名（+ 药丸）。窄屏用 flex-wrap，
          药丸放不下就自动掉到下一行，不会把标题挤出去。 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {/* 图标块：组色相的极淡底 + 细边，不是实心色块（实心太吵） */}
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
          style={{
            color: "var(--decor-hue)",
            borderColor: "color-mix(in srgb, var(--decor-hue) 30%, transparent)",
            background: "color-mix(in srgb, var(--decor-hue) 11%, transparent)",
          }}
        >
          <Icon className="size-4" />
        </span>

        <h1 className="text-[17px] leading-tight font-medium text-fg">{decor.title}</h1>

        {pill ? (
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] " +
              toneClass(pill.tone)
            }
          >
            {pill.label}
            <span className="font-medium tabular-nums">{pill.value}</span>
          </span>
        ) : null}

        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      {/* 第二行：一句话职能。独占一行——窄屏下横排会被挤掉，
          这是这一行唯一不能丢的信息（它回答"这页是干啥的"）。 */}
      <p className="mt-1 pl-0.5 text-[12px] leading-snug text-muted md:pl-[38px]">
        {decor.purpose}
      </p>
    </div>
  );
}

/**
 * L3 专属装饰件。
 *
 * 每种装饰对应一个页面的核心概念——不画通用的漂亮图案，
 * 画"这一页在讲什么"的东西。
 */
export function DecorOrnament({
  kind,
  children,
}: {
  kind: OrnamentKind | undefined;
  /** 页面传进来的真实数据（没有就不画，不编） */
  children?: ReactNode;
}) {
  if (!kind) return null;
  return (
    <div aria-hidden className="relative z-[1] flex items-center gap-2 px-0.5 pt-0.5">
      <OrnamentBody kind={kind}>{children}</OrnamentBody>
    </div>
  );
}

function OrnamentBody({ kind, children }: { kind: OrnamentKind; children?: ReactNode }) {
  switch (kind) {
    case "flow-arrows":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <ArrowUpRight className="size-3.5 text-up" />
          <span className="text-[11px]">流入</span>
          <ArrowDownRight className="size-3.5 text-down" />
          <span className="text-[11px]">流出</span>
          <ChevronRight className="size-3" />
          {children}
        </span>
      );
    case "gate-badges":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <GitBranch className="size-3.5" />
          <span className="text-[11px]">六关判决</span>
          {children}
        </span>
      );
    case "evidence-chain":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <Sparkles className="size-3.5" />
          <span className="text-[11px]">证据链</span>
          {children}
        </span>
      );
    case "debate-split":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <Scale className="size-3.5" />
          <span className="text-[11px]">多空对照</span>
          {children}
        </span>
      );
    case "ladder-rungs":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <Zap className="size-3.5" />
          <span className="text-[11px]">连板梯队</span>
          {children}
        </span>
      );
    case "style-preview":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <Circle className="size-3.5" />
          <span className="text-[11px]">风格预览</span>
          {children}
        </span>
      );
    case "trend-spark":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <ArrowUpRight className="size-3.5" />
          <span className="text-[11px]">走势</span>
          {children}
        </span>
      );
    case "pulse-wave":
      return (
        <span className="flex items-center gap-1.5 text-muted">
          <CheckCircle2 className="size-3.5" />
          <span className="text-[11px]">实时</span>
          {children}
        </span>
      );
    default:
      return null;
  }
}

/** 装在 Frame 里的便捷出口：一次拿到当前路径的装饰配置。 */
export function usePageDecor(path: string): PageDecor | null {
  return decorFor(path);
}
