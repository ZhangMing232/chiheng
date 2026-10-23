/**
 * 这个文件是干什么的：
 * 自媒体图文的配图画笔。**一套底色、多种版式**——深色行情风不变，
 * 但按内容体裁选版式：榜单用排名列表、事件用事件卡、复盘用大数字、
 * 连板用梯队条。以前所有内容都塞进排名列表，所以怎么看都像套公式。
 *
 * 你需要知道的：
 * - 红涨绿跌：红 #ff5c5c、绿 #2dd4a0；金色 #f5b544 做名次和品牌点缀。
 * - 抖音 = 1080×1920（9:16），公众号 = 1080×1440（3:4）。
 * - 版式由 StudioSpec.layout 决定：ranking / event / stat / ladder。
 *   每种版式是独立绘制函数，共享顶栏（日期+赤轨）和底部免责。
 */

const BG_TOP = "#171b26";
const BG_BOTTOM = "#0b0d13";
const CARD = "#1e2432";
const INK = "#f5f6f8";
const MUTED = "#828b9e";
const RED = "#ff5c5c";
const GREEN = "#2dd4a0";
const GOLD = "#f5b544";

const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif';

import { baseRowHeight, FOOT_ROOM, rankRowHeights } from "./studio-layout.ts";

export type StudioFormat = "vertical" | "square";

/** 版式：ranking 排名列表 · event 事件卡 · stat 大数字 · ladder 梯队条。 */
export type StudioLayout = "ranking" | "event" | "stat" | "ladder";

/** 一条内容（ranking 用）。value 是右边大数字，color 红/绿/中性，note 可选。 */
export type StudioItem = { name: string; value: string; color: string; note?: string };

/** 复盘用的大数字块。 */
export type StudioStat = { label: string; value: string; sub?: string; color?: string };

/** 涨跌分布（recap 用）。up/down/flat 是只数。 */
export type StudioBreadth = { up: number; down: number; flat: number; limitUp?: number; limitDown?: number };

/** 连板梯队的一级（sentiment 用）。 */
export type StudioRung = { streak: number; count: number };

/**
 * 分布条（ranking 用）：前几名合计 vs 其余。
 * 单看排名不知道"这是不是全部"——前 3 就占了七成，和前 3 只占两成，
 * 是两种完全不同的故事。
 */
export type StudioDist = { label: string; top: number; rest: number };

/** 小榜（stat 用）：并列的 mini 榜，如领涨/领跌板块。 */
export type StudioMini = { title: string; rows: { name: string; value: string; color?: string }[] };

/** 一张图文海报的内容规格。 */
export type StudioSpec = {
  title: string;
  subtitle?: string;
  layout: StudioLayout;
  /** ranking / hotmoney */
  items?: StudioItem[];
  /** event：正文段落（已按句拆好，绘制时换行） */
  body?: string[];
  /** event：来源/时间行 */
  meta?: string;
  /** recap */
  stats?: StudioStat[];
  breadth?: StudioBreadth;
  /** sentiment */
  rungs?: StudioRung[];
  /** 情绪脚注（sentiment，一句人话） */
  mood?: string;
  /** ranking：头部分布条 */
  dist?: StudioDist;
  /** stat：底部并列小榜 */
  mini?: StudioMini[];
  /** 底部补充一行（涨跌家数这类） */
  footNote?: string;
};

function canvasOf(format: StudioFormat): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; W: number; H: number } {
  const W = 1080;
  const H = format === "vertical" ? 1920 : 1440;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP);
  grad.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 0, 0);
  ctx.fillRect(0, 0, W, H);
  return { canvas, ctx, W, H };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

/** 简易换行：按像素宽度断行，中文按字断（没有空格可依赖）。 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** 顶栏（日期 + 品牌）+ 大标题，返回内容区起始 y。各版式共用。 */
function chrome(ctx: CanvasRenderingContext2D, W: number, spec: StudioSpec, at: number): number {
  const pad = 72;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.fillText(headline(at), pad, 92);
  ctx.textAlign = "right";
  ctx.fillStyle = GOLD;
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText("赤轨", W - pad, 92);

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 64px ${FONT}`;
  const titleLines = wrapText(ctx, spec.title, W - pad * 2).slice(0, 2);
  titleLines.forEach((line, i) => ctx.fillText(line, pad, 180 + i * 74));
  let y = 180 + titleLines.length * 74 + 24;
  if (spec.subtitle) {
    ctx.fillStyle = MUTED;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(spec.subtitle, pad, y);
    y += 56;
  }
  return y + 24;
}

/** 底部免责，各版式共用。 */
function footer(ctx: CanvasRenderingContext2D, W: number, H: number, note?: string) {
  const pad = 72;
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText(note ?? "数据不构成投资建议 · 赤轨", pad, H - 48);
}

// ── 版式一：排名列表 ────────────────────────────────────────────────

function drawRanking(ctx: CanvasRenderingContext2D, W: number, H: number, spec: StudioSpec, y0: number) {
  const pad = 72;
  const items = spec.items ?? [];
  // 分布条：前 3 名合计 vs 其余（单看排名不知道这是不是全部）
  if (spec.dist) {
    const { top, rest } = spec.dist;
    const total = Math.abs(top) + Math.abs(rest);
    const barY = y0;
    const barH = 56;
    const barW = W - pad * 2;
    ctx.fillStyle = "#2a3143";
    roundRect(ctx, pad, barY, barW, barH, 14);
    ctx.fill();
    if (total > 0) {
      const w = (Math.abs(top) / total) * barW;
      ctx.fillStyle = Math.abs(top) >= Math.abs(rest) ? RED : "#4a5468";
      roundRect(ctx, pad, barY, Math.max(w, 8), barH, 14);
      ctx.fill();
    }
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(spec.dist.label, pad, barY + barH + 40);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(`${studioAbsWan(top)} / ${studioAbsWan(rest)}`, pad + barW, barY + barH + 40);
    y0 = barY + barH + 78;
  }

  // 行高：**必须等分布条画完再算**——分布条占掉的高度要从可用高度里扣掉，
  // 否则列表会压到事实行/免责区（2026-10-16 实测修掉的 bug：canvas 侧顺序反了，
  // SVG 侧顺序对，两条路不一致）。
  // 带小字（note）的行必须更高，否则小字会画到下一张卡片上；
  // 还要按剩余空间自适应（内容少时把画布撑满，竖版下面空一半像没做完）。
  // **算法在 studio-layout.ts，SVG 路线共用**——两边各算各的图会不一样。
  const heights = rankRowHeights(items, H - y0 - FOOT_ROOM, baseRowHeight(items.length));
  const hOf = (i: number): number => heights[i] ?? heights[heights.length - 1] ?? 112;

  let cursor = y0;
  items.forEach((item, i) => {
    const ry = cursor;
    cursor += hOf(i);
    ctx.fillStyle = CARD;
    roundRect(ctx, pad, ry, W - pad * 2, hOf(i) - 16, 20);
    ctx.fill();

    // 文字**随行高垂直居中**（行高会自适应放大，写死偏移会全挤在卡片上半部）
    const cardH = hOf(i) - 16;
    const midY = ry + cardH / 2;
    const mainY = item.note ? midY - 4 : midY + 12;

    ctx.textAlign = "left";
    ctx.fillStyle = GOLD;
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(String(i + 1).padStart(2, "0"), pad + 32, mainY);

    ctx.fillStyle = INK;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(item.name, pad + 120, mainY);

    if (item.note) {
      ctx.fillStyle = MUTED;
      ctx.font = `24px ${FONT}`;
      ctx.fillText(item.note, pad + 120, midY + 38);
    }

    ctx.textAlign = "right";
    ctx.fillStyle = item.color;
    ctx.font = `bold 40px ${FONT}`;
    ctx.fillText(item.value, W - pad - 32, mainY + 8);
  });

  // 补充行（涨跌家数这类）
  if (spec.footNote) {
    // y 用累加后的位置，不是「条数 × 统一行高」——带小字的行更高，固定算会错位
    const fy = cursor + 16;
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `26px ${FONT}`;
    ctx.fillText(spec.footNote, pad, fy);
  }
}

// ── 版式二：事件卡 ──────────────────────────────────────────────────

function drawEvent(ctx: CanvasRenderingContext2D, W: number, H: number, spec: StudioSpec, y0: number) {
  const pad = 72;
  // meta 行（来源/时间）
  if (spec.meta) {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `26px ${FONT}`;
    ctx.fillText(spec.meta, pad, y0);
    y0 += 56;
  }
  // 正文卡片：按行排，行距宽松，像给人读的一段话
  const cardTop = y0;
  const cardH = Math.min(H - cardTop - 140, 900);
  ctx.fillStyle = CARD;
  roundRect(ctx, pad, cardTop, W - pad * 2, cardH, 24);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `32px ${FONT}`;
  let ly = cardTop + 64;
  for (const para of spec.body ?? []) {
    for (const line of wrapText(ctx, para, W - pad * 2 - 96)) {
      ctx.fillText(line, pad + 48, ly);
      ly += 56;
    }
    ly += 24; // 段间距
  }
}

// ── 版式三：大数字（复盘） ──────────────────────────────────────────

function drawStat(ctx: CanvasRenderingContext2D, W: number, H: number, spec: StudioSpec, y0: number) {
  const pad = 72;
  const stats = spec.stats ?? [];
  // 指数大卡：一列排（竖版）或两列（横版），每卡 label + 大数字 + 涨跌幅
  const cols = stats.length <= 2 ? 1 : 2;
  const gap = 24;
  const cardW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const cardH = 220;
  stats.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = pad + col * (cardW + gap);
    const cy = y0 + row * (cardH + gap);
    ctx.fillStyle = CARD;
    roundRect(ctx, cx, cy, cardW, cardH, 24);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `28px ${FONT}`;
    ctx.fillText(s.label, cx + 36, cy + 56);
    ctx.fillStyle = s.color ?? INK;
    ctx.font = `bold 72px ${FONT}`;
    ctx.fillText(s.value, cx + 36, cy + 140);
    ctx.textAlign = "right";
    if (s.sub) {
      ctx.fillStyle = s.color ?? INK;
      ctx.font = `bold 36px ${FONT}`;
      ctx.fillText(s.sub, cx + cardW - 36, cy + 140);
    }
  });

  // 涨跌分布横条
  const b = spec.breadth;
  if (b) {
    const total = Math.max(1, b.up + b.down + b.flat);
    const barY = y0 + Math.ceil(stats.length / cols) * (cardH + gap) + 24;
    const barW = W - pad * 2;
    const barH = 88;
    let bx = pad;
    const seg = (n: number, color: string) => {
      const w = (n / total) * barW;
      ctx.fillStyle = color;
      ctx.fillRect(bx, barY, w, barH);
      bx += w;
    };
    seg(b.up, RED);
    seg(b.flat, "#3a4255");
    seg(b.down, GREEN);
    // 条上数字（白色，压在最宽的那段上方）
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(`涨 ${b.up}`, pad + 28, barY + 56);
    ctx.textAlign = "right";
    ctx.fillText(`跌 ${b.down}`, pad + barW - 28, barY + 56);
    ctx.textAlign = "center";
    ctx.fillStyle = MUTED;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(`涨停 ${b.limitUp ?? 0} · 跌停 ${b.limitDown ?? 0}`, pad + barW / 2, barY + barH + 52);
  }

  // 并列小榜（领涨/领跌这类）：两个卡片并排，各 3 条
  const mini = spec.mini ?? [];
  if (mini.length > 0) {
    const gap = 24;
    const cardW = (W - pad * 2 - gap * (mini.length - 1)) / mini.length;
    const rowH = 56;
    const cardH = 64 + mini[0]!.rows.length * rowH;
    const baseY = y0 + Math.ceil(stats.length / cols) * (cardH + gap) + 190;
    mini.forEach((m, mi) => {
      const mx = pad + mi * (cardW + gap);
      ctx.fillStyle = CARD;
      roundRect(ctx, mx, baseY, cardW, cardH, 20);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = MUTED;
      ctx.font = `26px ${FONT}`;
      ctx.fillText(m.title, mx + 28, baseY + 46);
      m.rows.forEach((r, ri) => {
        const ry = baseY + 88 + ri * rowH;
        ctx.fillStyle = INK;
        ctx.font = `30px ${FONT}`;
        ctx.fillText(r.name, mx + 28, ry);
        ctx.textAlign = "right";
        ctx.fillStyle = r.color ?? INK;
        ctx.font = `bold 30px ${FONT}`;
        ctx.fillText(r.value, mx + cardW - 28, ry);
        ctx.textAlign = "left";
      });
    });
  }
}

// ── 版式四：连板梯队 ────────────────────────────────────────────────

function drawLadder(ctx: CanvasRenderingContext2D, W: number, H: number, spec: StudioSpec, y0: number) {
  const pad = 72;
  const rungs = spec.rungs ?? [];
  const max = Math.max(1, ...rungs.map((r) => r.count));
  const rowH = 128;
  rungs.forEach((r, i) => {
    const ry = y0 + i * rowH;
    // 左侧金色标签「N板」
    ctx.fillStyle = GOLD;
    ctx.font = `bold 44px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(`${r.streak}板`, pad, ry + 60);
    // 横条：长度按占最大值的比例，最窄也给 8% 看得见
    const barX = pad + 150;
    const barMax = W - pad - barX - 220;
    const w = Math.max(barMax * 0.08, (r.count / max) * barMax);
    ctx.fillStyle = r.streak >= 3 ? RED : "#4a5468";
    roundRect(ctx, barX, ry + 16, w, 72, 16);
    ctx.fill();
    // 右侧数量
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `bold 48px ${FONT}`;
    ctx.fillText(`${r.count} 只`, W - pad, ry + 66);
  });
  // 情绪脚注
  if (spec.mood) {
    let my = y0 + rungs.length * rowH + 30;
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `30px ${FONT}`;
    for (const line of wrapText(ctx, spec.mood, W - pad * 2).slice(0, 2)) {
      ctx.fillText(line, pad, my);
      my += 44;
    }
  }
}

/** 画一张图文海报。 */
export function drawStudioPoster(spec: StudioSpec, format: StudioFormat, at = Date.now()): { canvas: HTMLCanvasElement; filename: string } {
  const { canvas, ctx, W, H } = canvasOf(format);
  const y0 = chrome(ctx, W, spec, at);
  switch (spec.layout) {
    case "event":
      drawEvent(ctx, W, H, spec, y0);
      break;
    case "stat":
      drawStat(ctx, W, H, spec, y0);
      break;
    case "ladder":
      drawLadder(ctx, W, H, spec, y0);
      break;
    default:
      drawRanking(ctx, W, H, spec, y0);
  }
  footer(ctx, W, H);
  return { canvas, filename: `赤轨-${headline(at)}-${format === "vertical" ? "抖音" : "公众号"}.png` };
}

// ── 给内容构造器用的颜色 + 格式化工具 ──
export const STUDIO_RED = RED;
export const STUDIO_GREEN = GREEN;
export const STUDIO_INK = INK;
export const STUDIO_MUTED = MUTED;

export function studioTone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return INK;
  return n > 0 ? RED : GREEN;
}

export function studioAbsWan(wan: number): string {
  const abs = Math.abs(wan);
  if (!Number.isFinite(abs)) return "—";
  if (abs >= 10000) return `${(abs / 10000).toFixed(1)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

export function studioPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
