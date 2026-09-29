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
  canvas.height = 4800;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, POSTER_W, 4800);
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

export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char.trim() ? char : "";
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function paintSized(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, size: number, min = 16) {
  let next = size;
  ctx.font = `${next}px ${FONT}`;
  while (next > min && ctx.measureText(text).width > maxWidth) {
    next -= 2;
    ctx.font = `${next}px ${FONT}`;
  }
  ctx.fillText(ctx.measureText(text).width > maxWidth ? fit(ctx, text, maxWidth) : text, x, y);
}
export function paintCards(
  ctx: CanvasRenderingContext2D,
  y: number,
  cards: { label: string; value: string; color: string; note: string }[],
): number {
  const gap = 16;
  const cardW = (POSTER_W - 112 - gap * (cards.length - 1)) / cards.length;
  const inner = cardW - 40;
  ctx.font = `18px ${FONT}`;
  const notes = cards.map((card) => wrapLines(ctx, card.note, inner).slice(0, 2));
  const cardH = 132 + Math.max(...notes.map((lines) => lines.length), 1) * 22;
  cards.forEach((card, index) => {
    const x = 56 + index * (cardW + gap);
    ctx.fillStyle = CARD;
    ctx.fillRect(x, y, cardW, cardH);
    ctx.strokeStyle = LINE;
    ctx.strokeRect(x + 0.5, y + 0.5, cardW - 1, cardH - 1);
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(card.label, x + 20, y + 28);
    ctx.fillStyle = card.color;
    paintSized(ctx, card.value, x + 20, y + 76, inner, 36, 18);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT}`;
    notes[index].forEach((line, lineIndex) => ctx.fillText(line, x + 20, y + 112 + lineIndex * 22));
  });
  return y + cardH;
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
  const lines = wrapLines(ctx, note, POSTER_W - 112);
  lines.forEach((line, index) => ctx.fillText(line, 56, y + 36 + index * 30));
  const foot = y + 36 + lines.length * 30;
  ctx.fillStyle = "#5d6b7c";
  ctx.font = `20px ${FONT}`;
  ctx.fillText("赤轨 · 复盘用 · 不是买卖依据", 56, foot + 8);
  return foot + 40;
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
