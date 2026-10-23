/**
 * 这个文件是干什么的：
 * 自媒体图文的配图，走「现代财经海报」风格（对标小红书/公众号的财经数据图）：
 * 浅色底、大字标题、大号核心数字、红绿涨跌条形、圆角卡片、竖版优先。
 *
 * 你需要知道的：
 * - 完全独立于 poster.ts 那套「终端暗色」海报，这里重新起一套配色和布局。
 * - 红涨绿跌（A 股习惯）：红 #E64545、绿 #1AAB6A。
 * - 抖音 = 1080×1920（9:16），公众号 = 1080×1440（3:4）。
 */

import type { FlowBook, FlowRow } from "./flow.ts";
import type { IndexQuote } from "./types.ts";
import type { Breadth } from "./slim-universe.ts";

// ── 配色（现代财经图，浅底红绿）──
const BG = "#f6f7f9";
const CARD = "#ffffff";
const INK = "#17181c";
const MUTED = "#8a8f98";
const LINE = "#e6e8ec";
const RED = "#e64545"; // 涨
const GREEN = "#1aab6a"; // 跌
const BRAND = "#6c5ce7"; // 品牌强调色

const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif';

export type StudioFormat = "vertical" | "square";

function canvasOf(format: StudioFormat): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; W: number; H: number } {
  const W = 1080;
  const H = format === "vertical" ? 1920 : 1440;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.fillStyle = BG;
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

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function tone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return INK;
  return n > 0 ? RED : GREEN;
}

function absWan(wan: number): string {
  const abs = Math.abs(wan);
  if (!Number.isFinite(abs)) return "—";
  if (abs >= 10000) return `${(abs / 10000).toFixed(1)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

/** 顶部：日期 + 品牌。返回内容起始 y。 */
function paintTop(ctx: CanvasRenderingContext2D, date: string, W: number): number {
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `28px ${FONT}`;
  ctx.fillText(date, 72, 96);
  ctx.textAlign = "right";
  ctx.fillStyle = BRAND;
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText("赤轨 · 数据不构成投资建议", W - 72, 96);
  return 172;
}

/** 大标题。 */
function paintTitle(ctx: CanvasRenderingContext2D, title: string, W: number, y: number): number {
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 72px ${FONT}`;
  ctx.fillText(title, 72, y);
  return y + 44;
}

/** 核心指数卡片（横排三张：上证/深证/创业板）。 */
function paintIndexCards(ctx: CanvasRenderingContext2D, indices: IndexQuote[], W: number, y: number): number {
  const pad = 72;
  const gap = 24;
  const cardW = (W - pad * 2 - gap * 2) / 3;
  const cardH = 208;
  for (let i = 0; i < 3; i += 1) {
    const x = pad + i * (cardW + gap);
    const item = indices[i];
    ctx.fillStyle = CARD;
    roundRect(ctx, x, y, cardW, cardH, 24);
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!item) continue;
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `26px ${FONT}`;
    ctx.fillText(item.name, x + 32, y + 58);
    ctx.fillStyle = INK;
    ctx.font = `bold 52px ${FONT}`;
    ctx.fillText(item.price > 0 ? item.price.toFixed(2) : "—", x + 32, y + 128);
    ctx.fillStyle = tone(item.pct);
    ctx.font = `bold 38px ${FONT}`;
    ctx.fillText(pct(item.pct), x + 32, y + 178);
  }
  return y + cardH + 44;
}

/** 涨跌分布：横向堆积条（红涨/绿跌/灰平）+ 图例。 */
function paintBreadth(ctx: CanvasRenderingContext2D, breadth: Breadth, W: number, y: number): number {
  const pad = 72;
  const barW = W - pad * 2;
  const total = breadth.up + breadth.down + breadth.flat || 1;
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText("涨跌分布", pad, y);
  y += 30;

  const barH = 56;
  const upW = (breadth.up / total) * barW;
  const downW = (breadth.down / total) * barW;
  if (upW > 0) {
    ctx.fillStyle = RED;
    roundRect(ctx, pad, y, Math.max(upW, 8), barH, 28);
    ctx.fill();
  }
  if (downW > 0) {
    ctx.fillStyle = GREEN;
    ctx.fillRect(pad + upW, y, downW, barH);
  }
  ctx.fillStyle = LINE;
  roundRect(ctx, pad + upW + downW, y, Math.max(barW - upW - downW, 8), barH, 28);
  ctx.fill();

  y += barH + 32;
  ctx.font = `28px ${FONT}`;
  const legend = [
    { label: `上涨 ${breadth.up}`, color: RED, p: `${((breadth.up / total) * 100).toFixed(1)}%` },
    { label: `下跌 ${breadth.down}`, color: GREEN, p: `${((breadth.down / total) * 100).toFixed(1)}%` },
    { label: `平盘 ${breadth.flat}`, color: MUTED, p: `${((breadth.flat / total) * 100).toFixed(1)}%` },
  ];
  let lx = pad;
  for (const item of legend) {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, y - 22, 16, 16);
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(`${item.label} ${item.p}`, lx + 28, y);
    lx += ctx.measureText(`${item.label} ${item.p}`).width + 28 + 48;
  }
  return y + 40;
}

/** 资金简表：成交额 + 主力 + 净流入前 3。 */
function paintFlowSummary(ctx: CanvasRenderingContext2D, flow: FlowBook | null, W: number, y: number): number {
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText("资金", 72, y);
  y += 30;

  const amount = flow?.tape.reduce((sum, row) => sum + row.amount, 0) ?? 0;
  const main = flow?.market.reduce((sum, part) => sum + part.main, 0) ?? 0;
  const rows: { label: string; value: string; color: string }[] = [
    { label: "两市成交额", value: amount > 0 ? absWan(amount) : "—", color: INK },
    { label: "主力净额", value: main > 0 ? `+${absWan(main)}` : main < 0 ? `-${absWan(main)}` : "—", color: tone(main) },
  ];
  for (const s of (flow?.sectorsIn ?? []).slice(0, 3)) rows.push({ label: s.name, value: `+${absWan(s.inflow)}`, color: RED });

  const pad = 72;
  for (const row of rows) {
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(row.label, pad, y);
    ctx.textAlign = "right";
    ctx.fillStyle = row.color;
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillText(row.value, W - pad, y);
    y += 58;
  }
  return y + 16;
}

/** 每日复盘海报。format: vertical=抖音9:16, square=公众号3:4。 */
export function drawDailyPoster(input: { indices: IndexQuote[]; breadth: Breadth; flow: FlowBook | null; title?: string }, format: StudioFormat): { canvas: HTMLCanvasElement; filename: string } {
  const { indices, breadth, flow, title } = input;
  const { canvas, ctx, W } = canvasOf(format);
  const at = flow?.asOf ?? Date.now();
  let y = paintTop(ctx, headline(at), W);
  y = paintTitle(ctx, title ?? "今日 A 股", W, y);
  y = paintIndexCards(ctx, indices, W, y);
  y = paintBreadth(ctx, breadth, W, y);
  y = paintFlowSummary(ctx, flow, W, y);
  return { canvas, filename: `赤轨-复盘-${headline(at)}-${format === "vertical" ? "抖音" : "公众号"}.png` };
}

/** 两栏板块流入/流出列表。 */
function paintTwoCols(ctx: CanvasRenderingContext2D, leftTitle: string, leftRows: FlowRow[], rightTitle: string, rightRows: FlowRow[], W: number, y: number): number {
  const pad = 72;
  const colW = (W - pad * 2 - 24) / 2;
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillText(leftTitle, pad, y + 16);
  ctx.fillText(rightTitle, pad + colW + 24, y + 16);
  for (let i = 0; i < 3; i += 1) {
    const yy = y + 56 + i * 64;
    for (const side of [0, 1] as const) {
      const x = side === 0 ? pad : pad + colW + 24;
      const row = side === 0 ? leftRows[i] : rightRows[i];
      const color = side === 0 ? RED : GREEN;
      ctx.fillStyle = CARD;
      roundRect(ctx, x, yy, colW, 52, 16);
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = INK;
      ctx.font = `28px ${FONT}`;
      ctx.fillText(row ? row.name : "—", x + 24, yy + 36);
      ctx.textAlign = "right";
      ctx.fillStyle = color;
      ctx.fillText(row ? `${row.inflow > 0 ? "+" : ""}${absWan(row.inflow)}` : "—", x + colW - 24, yy + 36);
    }
  }
  return y + 56 + 3 * 64 + 40;
}

/** 资金异动海报（同样浅色现代风）。 */
export function drawStudioFlowPoster(flow: FlowBook, format: StudioFormat): { canvas: HTMLCanvasElement; filename: string } {
  const { canvas, ctx, W } = canvasOf(format);
  const at = flow.asOf;
  let y = paintTop(ctx, headline(at), W);
  y = paintTitle(ctx, "资金异动", W, y);

  const amount = flow.tape.reduce((sum, row) => sum + row.amount, 0);
  const main = flow.market.reduce((sum, part) => sum + part.main, 0);
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText("资金", 72, y);
  y += 30;
  const rows: { label: string; value: string; color: string }[] = [
    { label: "两市成交额", value: amount > 0 ? absWan(amount) : "—", color: INK },
    { label: "主力净额", value: main > 0 ? `+${absWan(main)}` : main < 0 ? `-${absWan(main)}` : "—", color: tone(main) },
  ];
  for (const row of rows) {
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(row.label, 72, y);
    ctx.textAlign = "right";
    ctx.fillStyle = row.color;
    ctx.font = `bold 32px ${FONT}`;
    ctx.fillText(row.value, W - 72, y);
    y += 58;
  }
  y = paintTwoCols(ctx, "板块净流入", flow.sectorsIn, "板块净流出", flow.sectorsOut, W, y);
  return { canvas, filename: `赤轨-资金-${headline(at)}-${format === "vertical" ? "抖音" : "公众号"}.png` };
}
