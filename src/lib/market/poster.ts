export const POSTER_W = 1080;
export const FONT = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

type Chrome = "mark" | "bar" | "rail" | "grid" | "frame" | "gold" | "glow" | "split";

type PosterTheme = {
  name: string;
  chrome: Chrome;
  bg: string;
  up: string;
  down: string;
  ink: string;
  muted: string;
  line: string;
  card: string;
  accent: string;
};

const THEMES: PosterTheme[] = [
  { name: "夜轨", chrome: "mark", bg: "#070b10", up: "#f0535e", down: "#2fbf8a", ink: "#e8eef6", muted: "#8b97a8", line: "#243044", card: "#121820", accent: "#f0535e" },
  { name: "青图", chrome: "grid", bg: "#061018", up: "#ff5d6c", down: "#2ee6c7", ink: "#e7fbff", muted: "#7f9aa8", line: "#16404a", card: "#0c1c24", accent: "#39d6e8" },
  { name: "金线", chrome: "gold", bg: "#0c0a07", up: "#e25b4a", down: "#3dba8b", ink: "#f6edd9", muted: "#a89880", line: "#3a3124", card: "#16130e", accent: "#d4b483" },
  { name: "赤条", chrome: "bar", bg: "#10080c", up: "#ff4d5a", down: "#2fbf8a", ink: "#f7eef0", muted: "#c9a8ae", line: "#3a2430", card: "#1a1016", accent: "#e1062e" },
  { name: "侧轨", chrome: "rail", bg: "#090d14", up: "#ff6b6b", down: "#4ecdc4", ink: "#eef3f8", muted: "#8ea0b3", line: "#243246", card: "#121a26", accent: "#4ecdc4" },
  { name: "霜格", chrome: "frame", bg: "#14181e", up: "#ff6a74", down: "#5dcaa5", ink: "#f2f5f8", muted: "#9aa6b2", line: "#2c3542", card: "#1c232c", accent: "#d7e2ee" },
  { name: "墨金", chrome: "split", bg: "#050505", up: "#ff4d4d", down: "#1f9d78", ink: "#f3f3f3", muted: "#8a8a8a", line: "#2a2a2a", card: "#141414", accent: "#e6c27a" },
  { name: "极光", chrome: "glow", bg: "#07110f", up: "#ff6b81", down: "#2ee6a6", ink: "#e9fff6", muted: "#86a89a", line: "#1a3a32", card: "#0d1c18", accent: "#7cf0c4" },
];

let cursor = -1;
let active = THEMES[0];

export let RED = active.up;
export let GREEN = active.down;
export let INK = active.ink;
export let MUTED = active.muted;
export let LINE = active.line;
export let CARD = active.card;
export let BG = active.bg;

export function themeName(): string {
  return active.name;
}

/** 每次生成换一套，不连着重复。 */
export function beginPoster(): PosterTheme {
  let index = Math.floor(Math.random() * THEMES.length);
  if (index === cursor) index = (index + 1) % THEMES.length;
  cursor = index;
  active = THEMES[index];
  RED = active.up;
  GREEN = active.down;
  INK = active.ink;
  MUTED = active.muted;
  LINE = active.line;
  CARD = active.card;
  BG = active.bg;
  return active;
}

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
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, POSTER_W, 4800);
  ctx.textBaseline = "middle";
  paintChrome(ctx);
  return { canvas, ctx };
}

function paintChrome(ctx: CanvasRenderingContext2D) {
  if (active.chrome === "grid") {
    ctx.strokeStyle = active.accent;
    ctx.globalAlpha = 0.08;
    for (let x = 40; x < POSTER_W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 4800);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (active.chrome === "frame") {
    ctx.strokeStyle = active.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(28, 28, POSTER_W - 56, 4744);
    ctx.lineWidth = 1;
  }
  if (active.chrome === "rail") {
    ctx.fillStyle = active.accent;
    ctx.fillRect(0, 0, 18, 4800);
  }
  if (active.chrome === "bar") {
    ctx.fillStyle = active.accent;
    ctx.fillRect(0, 0, POSTER_W, 210);
  }
  if (active.chrome === "gold" || active.chrome === "split") {
    ctx.fillStyle = active.accent;
    ctx.fillRect(56, 96, POSTER_W - 112, active.chrome === "split" ? 2 : 3);
  }
}

export function paintMark(ctx: CanvasRenderingContext2D, date: string) {
  const onBar = active.chrome === "bar";
  const ink = onBar ? "#ffffff" : INK;
  const accent = onBar ? "#ffffff" : RED;
  if (!onBar) {
    ctx.fillStyle = active.chrome === "gold" || active.chrome === "split" ? active.accent : INK;
    ctx.fillRect(56, 56, 36, 8);
    ctx.fillStyle = accent;
    ctx.fillRect(100, 44, 36, 8);
  }
  ctx.fillStyle = ink;
  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("赤轨", onBar ? 56 : 152, 54);
  ctx.fillStyle = onBar ? "rgba(255,255,255,0.82)" : MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(date, POSTER_W - 56, 54);
}

export function paintTitle(ctx: CanvasRenderingContext2D, title: string, sub: string) {
  const onBar = active.chrome === "bar";
  ctx.textAlign = "left";
  ctx.fillStyle = onBar ? "#ffffff" : INK;
  ctx.font = `600 64px ${FONT}`;
  ctx.fillText(title, 56, 128);
  ctx.fillStyle = onBar ? "rgba(255,255,255,0.82)" : MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText(sub, 56, 176);
  if (active.chrome === "glow") {
    const grad = ctx.createLinearGradient(56, 198, 420, 198);
    grad.addColorStop(0, active.accent);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(56, 196, 360, 4);
  }
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
  ctx.fillText(`赤轨 · ${active.name} · 复盘用 · 不是买卖依据`, 56, foot + 8);
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
