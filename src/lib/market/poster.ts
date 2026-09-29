export const POSTER_W = 1080;
export const RED = "#f0535e";
export const GREEN = "#2fbf8a";
export const INK = "#e8eef6";
export const MUTED = "#8b97a8";
export const LINE = "#243044";
export const CARD = "#121820";
export const FONT = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

export function toneColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return INK;
  return n > 0 ? RED : GREEN;
}

export function dayFromDate(date: string): string {
  const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return date;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

export function fileDate(date: string): string {
  const match = date.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

export function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}…`).width > max) next = next.slice(0, -1);
  return `${next}…`;
}

export function openPoster(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = POSTER_W;
  canvas.height = 2400;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, POSTER_W, 2400);
  ctx.textBaseline = "middle";
  return { canvas, ctx };
}

export function paintMark(ctx: CanvasRenderingContext2D, date: string) {
  ctx.fillStyle = INK;
  ctx.fillRect(56, 56, 36, 8);
  ctx.fillStyle = RED;
  ctx.fillRect(100, 44, 36, 8);
  ctx.fillStyle = INK;
  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("赤轨", 152, 54);
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(date, POSTER_W - 56, 54);
}

export function paintTitle(ctx: CanvasRenderingContext2D, title: string, sub: string) {
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 64px ${FONT}`;
  ctx.fillText(title, 56, 128);
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText(sub, 56, 176);
}

export function paintCards(
  ctx: CanvasRenderingContext2D,
  y: number,
  cards: { label: string; value: string; color: string; note: string }[],
): number {
  const gap = 16;
  const cardW = (POSTER_W - 112 - gap * (cards.length - 1)) / cards.length;
  cards.forEach((card, index) => {
    const x = 56 + index * (cardW + gap);
    ctx.fillStyle = CARD;
    ctx.fillRect(x, y, cardW, 148);
    ctx.strokeStyle = LINE;
    ctx.strokeRect(x + 0.5, y + 0.5, cardW - 1, 147);
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(card.label, x + 20, y + 28);
    ctx.fillStyle = card.color;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(fit(ctx, card.value, cardW - 36), x + 20, y + 76);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(fit(ctx, card.note, cardW - 36), x + 20, y + 116);
  });
  return y + 148;
}

export function paintSection(ctx: CanvasRenderingContext2D, y: number, label: string, color: string, x = 56): number {
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 8, 18, 4);
  ctx.fillStyle = INK;
  ctx.font = `600 26px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(label, x + 28, y + 12);
  return y + 40;
}

export function paintFoot(ctx: CanvasRenderingContext2D, y: number, note: string): number {
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(56, y);
  ctx.lineTo(POSTER_W - 56, y);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(fit(ctx, note, POSTER_W - 112), 56, y + 36);
  ctx.fillStyle = "#5d6b7c";
  ctx.font = `20px ${FONT}`;
  ctx.fillText("赤轨 · 复盘用 · 不是买卖依据", 56, y + 72);
  return y + 108;
}

export function cropPoster(canvas: HTMLCanvasElement, height: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = POSTER_W;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.drawImage(canvas, 0, 0, POSTER_W, height, 0, 0, POSTER_W, height);
  return out;
}
