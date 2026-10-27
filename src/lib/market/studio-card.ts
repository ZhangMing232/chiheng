/**
 * 这个文件是干什么的：
 * 自媒体图文的 **SVG 模板层**（L1 改造的核心）。把 StudioSpec 变成 SVG 源码，
 * 交给 studio-svg.ts 渲染成 PNG。
 *
 * 为什么不用 canvas 手画了（这是 L1 的全部理由）：
 * - **声明式**：不用算坐标，改版式是改标签不是改算式
 * - **条件渲染**：字段没值就不画那一行/那一块（canvas 里要自己判空）
 * - **排版能力**：圆角/渐变/文本对齐都是现成属性
 * - **不重画一遍**：canvas 版保留做回退，两条路并存
 *
 * 你需要知道的：
 * 1. **文字换行要自己算**——SVG 不会自动换行。用 wrapCn() 估算宽度（CJK 按
 *    1 个字宽、西文按 0.55）手动断行，误差在可接受范围（标题最多 2 行）。
 * 2. **颜色沿用 canvas 版**（深色行情风、红涨绿跌），两条路视觉要一致。
 * 3. resvg 支持 SVG 1.1 常用子集：rect/circle/text/tspan/linearGradient/
 *    stroke/fill/opacity 都行；不支持 CSS 复杂选择器（所以样式都写成属性）。
 */

import { STUDIO_GREEN, STUDIO_INK, STUDIO_MUTED, STUDIO_RED, type StudioSpec } from "./studio-poster.ts";
import { baseRowHeight, FOOT_ROOM, rankRowHeights } from "./studio-layout.ts";

const BG_TOP = "#171b26";
const BG_BOTTOM = "#0b0d13";
const CARD = "#1e2432";
const GOLD = "#f5b544";

/** 估算文本宽度（CJK 全宽、西文半宽）。 */
export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    w += /[⺀-鿿＀-￯]/.test(ch) ? fontSize : fontSize * 0.55;
  }
  return w;
}

/** 按像素宽度断行（中文按字断，无空格可依赖）。 */
export function wrapCn(text: string, maxWidth: number, fontSize: number, maxLines = 2): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (textWidth(line + ch, fontSize) > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line += ch;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type SvgFormat = "vertical" | "square";
/**
 * 主题。**两套视觉系统**（2026-10-23 用户说"图太丑"后重做）：
 * - `dark` 深色行情风：紧凑卡片 + 左侧色条 + 金额比例条（短视频/直播场景友好）
 * - `light` 浅色杂志风：大字标题 + 细分割线 + 大量留白（公众号/小红书场景友好）
 *
 * 为什么不做"AI 画数据图"：AI 画的数字是编的（实测 AI 说"13.9亿砸向中际旭创"，
 * 真实值是 11.2 亿）——数据图必须模板渲染，数字是赤轨的红线。
 * AI 只适合封面氛围图（不含数字的那层）。
 */
export type StudioTheme = "dark" | "light";

export type ThemeTokens = {
  bgTop: string;
  bgBottom: string;
  card: string;
  cardLine: string;
  ink: string;
  muted: string;
  faint: string;
  up: string;
  down: string;
  gold: string;
  hairline: string;
};

export const THEMES: Record<StudioTheme, ThemeTokens> = {
  dark: {
    bgTop: "#0f1420",
    bgBottom: "#070a11",
    card: "#141a26",
    cardLine: "#1e2634",
    ink: "#ffffff",
    muted: "#8b95ab",
    faint: "#5a6478",
    up: "#ff4d4f",
    down: "#00b578",
    gold: "#f0b90b",
    hairline: "#232b3a",
  },
  light: {
    bgTop: "#faf7f2",
    bgBottom: "#f3efe7",
    card: "#f0ebe1",
    cardLine: "#e7e2d9",
    ink: "#1c1917",
    muted: "#57534e",
    faint: "#a8a29e",
    up: "#d92b2b",
    down: "#0f9d58",
    gold: "#c2410c",
    hairline: "#e7e2d9",
  },
};


function sizeOf(format: SvgFormat): { W: number; H: number } {
  return { W: 1080, H: format === "vertical" ? 1920 : 1440 };
}

/** 顶栏（日期 + 品牌）+ 大标题 + 副标题，返回内容区起始 y。 */
function chrome(family: string, spec: StudioSpec, W: number, at: number, th: ThemeTokens): { svg: string; y: number } {
  const pad = 72;
  const d = new Date(at);
  const dateText = `${d.getMonth() + 1}月${d.getDate()}日`;
  let svg = "";
  svg += `<text x="${pad}" y="92" font-family="${family}" font-size="26" fill="${th.muted}">${esc(dateText)}</text>`;
  svg += `<text x="${W - pad}" y="92" text-anchor="end" font-family="${family}" font-size="28" font-weight="bold" fill="${th.gold}">赤轨</text>`;

  const titleLines = wrapCn(spec.title, W - pad * 2, 64, 2);
  titleLines.forEach((line, i) => {
    svg += `<text x="${pad}" y="${180 + i * 74}" font-family="${family}" font-size="64" font-weight="bold" fill="${th.ink}">${esc(line)}</text>`;
  });
  let y = 180 + titleLines.length * 74 + 24;
  if (spec.subtitle) {
    svg += `<text x="${pad}" y="${y}" font-family="${family}" font-size="30" fill="${th.muted}">${esc(spec.subtitle)}</text>`;
    y += 56;
  }
  return { svg, y: y + 24 };
}

/** 分布条：前 3 合计 vs 其余。 */
function distBar(family: string, spec: StudioSpec, W: number, y: number, th: ThemeTokens): { svg: string; y: number } {
  const d = spec.dist;
  if (!d) return { svg: "", y };
  const pad = 72;
  const barW = W - pad * 2;
  const barH = 56;
  const total = Math.abs(d.top) + Math.abs(d.rest);
  const w = total > 0 ? Math.max((Math.abs(d.top) / total) * barW, 8) : barW;
  // 浅底上深灰太突兀 → 用主题的 faint；深底上用红
  const color = Math.abs(d.top) >= Math.abs(d.rest) ? th.up : th.faint;
  let svg = `<rect x="${pad}" y="${y}" width="${barW}" height="${barH}" rx="14" fill="${th.hairline}"/>`;
  svg += `<rect x="${pad}" y="${y}" width="${w}" height="${barH}" rx="14" fill="${color}"/>`;
  svg += `<text x="${pad}" y="${y + barH + 40}" font-family="${family}" font-size="24" fill="${th.muted}">${esc(d.label)}</text>`;
  const fmt = (n: number): string => {
    const a = Math.abs(n);
    return a >= 10000 ? `${(a / 10000).toFixed(1)}亿` : `${Math.round(a)}万`;
  };
  svg += `<text x="${pad + barW}" y="${y + barH + 40}" text-anchor="end" font-family="${family}" font-size="30" font-weight="bold" fill="${th.ink}">${fmt(d.top)} / ${fmt(d.rest)}</text>`;
  return { svg, y: y + barH + 78 };
}

/** 排名列表。行高按内容三态（带小字的行更高，小字不挤下一行）。 */
function rankingList(family: string, spec: StudioSpec, W: number, y0: number, H: number, th: ThemeTokens, theme: StudioTheme): { svg: string; y: number } {
  const items = spec.items ?? [];
  if (items.length === 0) return { svg: "", y: y0 };
  const pad = 72;
  const baseH = baseRowHeight(items.length);
  // 可用高度 = 画布高 - 内容起点 - 底部预留。行高按剩余空间自适应，
  // 否则竖版下面空一半（实测：5 条时只占 45% 画布）。
  const heights = rankRowHeights(items, H - y0 - FOOT_ROOM, baseH);
  let svg = "";
  let y = y0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const h = heights[i]!;
    const cardH = h - 16;
    if (theme === "dark") {
      svg += `<rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${cardH}" rx="16" fill="${th.card}"/>`;
    } else {
      // 浅色风不画卡片，只在行底画一条细分隔线（留白代替边框）
      svg += `<line x1="${pad}" y1="${y + cardH}" x2="${W - pad}" y2="${y + cardH}" stroke="${th.hairline}" stroke-width="2"/>`;
    }
    // 文字**随行高垂直居中**（行高会自适应放大，写死偏移会全挤在卡片上半部）
    const midY = y + cardH / 2;
    const mainY = item.note ? midY - 4 : midY + 12;
    if (theme === "light") {
      // 浅色杂志风：名次淡灰、名字黑大字、金额黑、右下无色条，靠分割线分节奏
      svg += `<text x="${pad}" y="${mainY}" font-family="${family}" font-size="28" fill="${th.faint}">${String(i + 1).padStart(2, "0")}</text>`;
      svg += `<text x="${pad + 86}" y="${mainY}" font-family="${family}" font-size="40" font-weight="bold" fill="${th.ink}">${esc(item.name)}</text>`;
      if (item.note) {
        svg += `<text x="${pad + 86}" y="${midY + 38}" font-family="${family}" font-size="28" fill="${item.color}">${esc(item.note)}</text>`;
      }
      svg += `<text x="${W - pad}" y="${mainY + 8}" text-anchor="end" font-family="${family}" font-size="46" font-weight="bold" fill="${th.ink}">${esc(item.value)}</text>`;
    } else {
      // 深色行情风：左侧色条 + 金色名次 + 白字名 + 彩色金额 + 底部比例条
      svg += `<rect x="${pad}" y="${y}" width="6" height="${cardH}" rx="3" fill="${item.color}"/>`;
      svg += `<text x="${pad + 34}" y="${mainY}" font-family="${family}" font-size="34" font-weight="bold" fill="${th.gold}">${String(i + 1).padStart(2, "0")}</text>`;
      svg += `<text x="${pad + 120}" y="${mainY}" font-family="${family}" font-size="42" font-weight="bold" fill="${th.ink}">${esc(item.name)}</text>`;
      if (item.note) {
        svg += `<text x="${pad + 120}" y="${midY + 38}" font-family="${family}" font-size="30" fill="${item.color}">${esc(item.note)}</text>`;
      }
      svg += `<text x="${W - pad - 34}" y="${mainY + 8}" text-anchor="end" font-family="${family}" font-size="56" font-weight="bold" fill="${th.ink}">${esc(item.value)}</text>`;
    }
    y += h;
  }
  return { svg, y };
}

/** 复盘版式：指数大数字卡 + 涨跌分布条 + 并列小榜。 */
function statLayout(family: string, spec: StudioSpec, W: number, y0: number, th: ThemeTokens): { svg: string; y: number } {
  const pad = 72;
  const stats = spec.stats ?? [];
  let svg = "";
  let y = y0;
  const cols = stats.length <= 2 ? 1 : 2;
  const gap = 24;
  const cardW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const cardH = 220;
  stats.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = pad + col * (cardW + gap);
    const cy = y + row * (cardH + gap);
    svg += `<rect x="${cx}" y="${cy}" width="${cardW}" height="${cardH}" rx="24" fill="${th.card}"/>`;
    svg += `<text x="${cx + 36}" y="${cy + 56}" font-family="${family}" font-size="28" fill="${th.muted}">${esc(s.label)}</text>`;
    svg += `<text x="${cx + 36}" y="${cy + 140}" font-family="${family}" font-size="72" font-weight="bold" fill="${s.color ?? STUDIO_INK}">${esc(s.value)}</text>`;
    if (s.sub) {
      svg += `<text x="${cx + cardW - 36}" y="${cy + 140}" text-anchor="end" font-family="${family}" font-size="36" font-weight="bold" fill="${s.color ?? STUDIO_INK}">${esc(s.sub)}</text>`;
    }
  });
  y += Math.ceil(Math.max(stats.length, 1) / cols) * (cardH + gap);

  const b = spec.breadth;
  if (b) {
    const barW = W - pad * 2;
    const total = Math.max(1, b.up + b.down + b.flat);
    const seg = (n: number, color: string, x: number): string =>
      `<rect x="${x}" y="${y}" width="${(n / total) * barW}" height="88" fill="${color}"/>`;
    let bx = pad;
    svg += seg(b.up, STUDIO_RED, bx);
    bx += (b.up / total) * barW;
    svg += seg(b.flat, "#3a4255", bx);
    bx += (b.flat / total) * barW;
    svg += seg(b.down, STUDIO_GREEN, bx);
    svg += `<text x="${pad + 28}" y="${y + 56}" font-family="${family}" font-size="34" font-weight="bold" fill="#ffffff">涨 ${b.up}</text>`;
    svg += `<text x="${pad + barW - 28}" y="${y + 56}" text-anchor="end" font-family="${family}" font-size="34" font-weight="bold" fill="#ffffff">跌 ${b.down}</text>`;
    svg += `<text x="${pad + barW / 2}" y="${y + 140}" text-anchor="middle" font-family="${family}" font-size="30" fill="${th.muted}">涨停 ${b.limitUp ?? 0} · 跌停 ${b.limitDown ?? 0}</text>`;
    y += 190;
  }

  const mini = spec.mini ?? [];
  if (mini.length > 0) {
    const mGap = 24;
    const mW = (W - pad * 2 - mGap * (mini.length - 1)) / mini.length;
    const rowH = 56;
    const mH = 64 + (mini[0]?.rows.length ?? 0) * rowH;
    mini.forEach((m, mi) => {
      const mx = pad + mi * (mW + mGap);
      svg += `<rect x="${mx}" y="${y}" width="${mW}" height="${mH}" rx="20" fill="${th.card}"/>`;
      svg += `<text x="${mx + 28}" y="${y + 46}" font-family="${family}" font-size="26" fill="${th.muted}">${esc(m.title)}</text>`;
      m.rows.forEach((r, ri) => {
        const ry = y + 88 + ri * rowH;
        svg += `<text x="${mx + 28}" y="${ry}" font-family="${family}" font-size="30" fill="${th.ink}">${esc(r.name)}</text>`;
        svg += `<text x="${mx + mW - 28}" y="${ry}" text-anchor="end" font-family="${family}" font-size="30" font-weight="bold" fill="${r.color ?? STUDIO_INK}">${esc(r.value)}</text>`;
      });
    });
    y += mH;
  }
  return { svg, y };
}

/** 事件卡：meta + 正文段落。 */
function eventLayout(family: string, spec: StudioSpec, W: number, y0: number, th: ThemeTokens): { svg: string; y: number } {
  const pad = 72;
  let svg = "";
  let y = y0;
  if (spec.meta) {
    svg += `<text x="${pad}" y="${y}" font-family="${family}" font-size="26" fill="${th.muted}">${esc(spec.meta)}</text>`;
    y += 56;
  }
  const body = spec.body ?? [];
  const lines: string[] = [];
  for (const para of body) {
    for (const line of wrapCn(para, W - pad * 2 - 96, 32, 4)) lines.push(line);
  }
  const cardH = Math.max(160, 64 + lines.length * 56 + (body.length - 1) * 24);
  svg += `<rect x="${pad}" y="${y}" width="${W - pad * 2}" height="${cardH}" rx="24" fill="${th.card}"/>`;
  let ly = y + 64;
  body.forEach((para, pi) => {
    for (const line of wrapCn(para, W - pad * 2 - 96, 32, 4)) {
      svg += `<text x="${pad + 48}" y="${ly}" font-family="${family}" font-size="32" fill="${th.ink}">${esc(line)}</text>`;
      ly += 56;
    }
    if (pi < body.length - 1) ly += 24;
  });
  y += cardH;
  return { svg, y };
}

/** 连板梯队。 */
function ladderLayout(family: string, spec: StudioSpec, W: number, y0: number, th: ThemeTokens): { svg: string; y: number } {
  const pad = 72;
  const rungs = spec.rungs ?? [];
  const max = Math.max(1, ...rungs.map((r) => r.count));
  let svg = "";
  let y = y0;
  for (const r of rungs) {
    svg += `<text x="${pad}" y="${y + 60}" font-family="${family}" font-size="44" font-weight="bold" fill="${th.gold}">${r.streak}板</text>`;
    const barX = pad + 150;
    const barMax = W - pad - barX - 220;
    const w = Math.max(barMax * 0.08, (r.count / max) * barMax);
    svg += `<rect x="${barX}" y="${y + 16}" width="${w}" height="72" rx="16" fill="${r.streak >= 3 ? STUDIO_RED : "#4a5468"}"/>`;
    svg += `<text x="${W - pad}" y="${y + 66}" text-anchor="end" font-family="${family}" font-size="48" font-weight="bold" fill="${th.ink}">${r.count} 只</text>`;
    y += 128;
  }
  if (spec.mood) {
    for (const line of wrapCn(spec.mood, W - pad * 2, 30, 2)) {
      svg += `<text x="${pad}" y="${y + 30}" font-family="${family}" font-size="30" fill="${th.muted}">${esc(line)}</text>`;
      y += 44;
    }
  }
  return { svg, y };
}

/**
 * 把 StudioSpec 渲染成 SVG 源码。
 *
 * 字体家族用参数传入（由 studio-svg.ts 探测可用字体后给）——**不写死**，
 * 因为写死的字体在这台机器上可能不存在（resvg 会静默不画字）。
 */
export function specToSvg(
  spec: StudioSpec,
  format: SvgFormat,
  family: string,
  at = Date.now(),
  theme: StudioTheme = "dark",
): string {
  const { W, H } = sizeOf(format);
  const pad = 72;
  const th = THEMES[theme];
  const head = chrome(family, spec, W, at, th);
  let body = "";
  const y = head.y;
  switch (spec.layout) {
    case "stat":
      body = statLayout(family, spec, W, y, th).svg;
      break;
    case "event":
      body = eventLayout(family, spec, W, y, th).svg;
      break;
    case "ladder":
      body = ladderLayout(family, spec, W, y, th).svg;
      break;
    default: {
      const d = distBar(family, spec, W, y, th);
      const list = rankingList(family, spec, W, d.y, H, th, theme);
      body = d.svg + list.svg;
      if (spec.footNote) {
        body += `<text x="${pad}" y="${list.y + 16}" font-family="${family}" font-size="26" fill="${th.muted}">${esc(spec.footNote)}</text>`;
      }
      break;
    }
  }
  const foot = `<text x="${pad}" y="${H - 48}" font-family="${family}" font-size="24" fill="${th.muted}">数据不构成投资建议 · 赤轨</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${th.bgTop}"/>
      <stop offset="1" stop-color="${th.bgBottom}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${head.svg}
  ${body}
  ${foot}
</svg>`;
}
