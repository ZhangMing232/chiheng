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

export type StudioFormat = "vertical" | "square";

/** 版式：ranking 排名列表 · event 事件卡 · stat 大数字 · ladder 梯队条。 */
export type StudioLayout = "ranking" | "event" | "stat" | "ladder";

/**
 * 一条内容（ranking 用）。value 是右边大数字，color 红/绿/中性。
 * sub = 第二行小字（涨跌幅），note = 第三行小字（游资的"买了啥"）。
 */
export type StudioItem = { name: string; value: string; color: string; sub?: string; note?: string };

/** 集中度分布（ranking 底部条）：前 3 名 vs 榜上其余。 */
export type StudioDistrib = { top3: number; rest: number; total: number };

/** 板块 mini 双榜（复盘用）：领涨/领跌各最多 3 条。 */
export type StudioSectorMini = { gain: StudioItem[]; lose: StudioItem[] };

/** 复盘用的大数字块。 */
export type StudioStat = { label: string; value: string; sub?: string; color?: string };

/** 涨跌分布（recap 用）。up/down/flat 是只数。 */
export type StudioBreadth = { up: number; down: number; flat: number; limitUp?: number; limitDown?: number };

/** 连板梯队的一级（sentiment 用）。 */
export type StudioRung = { streak: number; count: number };

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
  /** 炸板率 %（sentiment，/signals 汇总） */
  breakRate?: number | null;
  /** ranking：集中度分布条（不足 4 行 buildStudioSpec 不传，这里不画） */
  distrib?: StudioDistrib;
  /** ranking：底部一行市场事实（涨跌家数） */
  breadthLine?: string;
  /** recap：板块领涨/领跌 mini 双榜 */
  sectorMini?: StudioSectorMini;
  /** recap：底部事实行（从数据算的确定性描述） */
  facts?: string[];
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
  // 行高分档：带小字的行更高（名次/名字上移，小字在下面），保证不挤压
  const anySub = items.some((it) => it.sub || it.note);
  const rowH = anySub ? 132 : items.length > 10 ? 96 : 112;
  const baseY = anySub ? 54 : 66;
  items.forEach((item, i) => {
    const ry = y0 + i * rowH;
    ctx.fillStyle = CARD;
    roundRect(ctx, pad, ry, W - pad * 2, rowH - 16, 20);
    ctx.fill();

    // 名次（金色）+ 名字，同一基线
    ctx.textAlign = "left";
    ctx.fillStyle = GOLD;
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(String(i + 1).padStart(2, "0"), pad + 32, ry + baseY);

    ctx.fillStyle = INK;
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(item.name, pad + 120, ry + baseY);

    // sub（第二行小字：涨跌幅，红绿——+ 红 - 绿，0 灰）
    if (item.sub) {
      ctx.fillStyle = item.sub.startsWith("+") ? RED : item.sub.startsWith("-") ? GREEN : MUTED;
      ctx.font = `bold 26px ${FONT}`;
      ctx.fillText(item.sub, pad + 120, ry + baseY + 40);
    }

    // note（游资的"买了啥"，第三行小字，灰）
    if (item.note) {
      ctx.fillStyle = MUTED;
      ctx.font = `24px ${FONT}`;
      ctx.fillText(item.note, pad + 120, ry + baseY + (item.sub ? 76 : 40));
    }

    // 数值（右对齐，红绿），与名字同基线
    ctx.textAlign = "right";
    ctx.fillStyle = item.color;
    ctx.font = `bold 40px ${FONT}`;
    ctx.fillText(item.value, W - pad - 32, ry + baseY);
  });

  // 集中度分布条：前 3 名 vs 榜上其余（不足 4 行 buildStudioSpec 不传，这里不画）
  let afterY = y0 + items.length * rowH + 24;
  const d = spec.distrib;
  if (d && d.total > 0) {
    const barW = W - pad * 2;
    const barH = 40;
    const topRatio = Math.max(0, Math.min(1, d.top3 / d.total));
    ctx.fillStyle = RED;
    ctx.fillRect(pad, afterY, barW * topRatio, barH);
    ctx.fillStyle = "#3a4255";
    ctx.fillRect(pad + barW * topRatio, afterY, barW * (1 - topRatio), barH);
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillText(`前 3 名 ${(topRatio * 100).toFixed(0)}%`, pad + 24, afterY + 30);
    ctx.textAlign = "right";
    ctx.fillText(`其余 ${((1 - topRatio) * 100).toFixed(0)}%`, pad + barW - 24, afterY + 30);
    // 口径脚注：集中度只覆盖榜上，不是全市场（避免黑箱）
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText("集中度 = 榜上第 4-N 名之和的对比，不是全市场口径", pad, afterY + barH + 34);
    afterY += barH + 56;
  }

  // 底部市场事实行（涨跌家数，全市场真数据）
  if (spec.breadthLine) {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `26px ${FONT}`;
    ctx.fillText(spec.breadthLine, pad, afterY + 24);
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
