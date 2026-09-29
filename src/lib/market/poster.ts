export const POSTER_W = 1080;
export const FONT = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

type Kind = "night" | "print" | "gold" | "red" | "side" | "paper" | "term" | "glow";

type PosterTheme = {
  name: string;
  kind: Kind;
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
  { name: "夜轨", kind: "night", bg: "#070b10", up: "#f0535e", down: "#2fbf8a", ink: "#e8eef6", muted: "#8b97a8", line: "#243044", card: "#121820", accent: "#f0535e" },
  { name: "青图", kind: "print", bg: "#07141c", up: "#ff5d6c", down: "#2ee6c7", ink: "#dff7ff", muted: "#7f9aa8", line: "#1d4a56", card: "#0c222c", accent: "#39d6e8" },
  { name: "金线", kind: "gold", bg: "#0c0a07", up: "#e25b4a", down: "#3dba8b", ink: "#f6edd9", muted: "#a89880", line: "#6b5834", card: "#14110c", accent: "#d4b483" },
  { name: "赤条", kind: "red", bg: "#14080c", up: "#ff4d5a", down: "#2fbf8a", ink: "#fff4f6", muted: "#c9a8ae", line: "#4a2430", card: "#2a1018", accent: "#e1062e" },
  { name: "侧轨", kind: "side", bg: "#0c1218", up: "#ff6b6b", down: "#4ecdc4", ink: "#eef3f8", muted: "#8ea0b3", line: "#243246", card: "#16202b", accent: "#d7e4f2" },
  { name: "霜格", kind: "paper", bg: "#e4e7ee", up: "#d0121a", down: "#0b7a45", ink: "#16181d", muted: "#5c6570", line: "#c5cad3", card: "#ffffff", accent: "#16181d" },
  { name: "墨金", kind: "term", bg: "#000000", up: "#ff5c4d", down: "#5dff9a", ink: "#e6c57a", muted: "#8a7344", line: "#3a3018", card: "#000000", accent: "#e6c57a" },
  { name: "极光", kind: "glow", bg: "#061410", up: "#ff6b81", down: "#2ee6a6", ink: "#f3fff9", muted: "#86a89a", line: "#1a3a32", card: "#0d1c18", accent: "#7cf0c4" },
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

export function edge(): number {
  if (active.kind === "side") return 268;
  if (active.kind === "gold" || active.kind === "glow") return 80;
  if (active.kind === "print") return 64;
  return 48;
}

export function rightEdge(): number {
  return POSTER_W - (active.kind === "side" ? 40 : edge());
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
  if (active.kind === "print") {
    ctx.strokeStyle = active.accent;
    ctx.globalAlpha = 0.12;
    for (let x = 32; x < POSTER_W; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 4800);
      ctx.stroke();
    }
    for (let y = 32; y < 4800; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(POSTER_W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    corner(ctx, 36, 36, 1, 1);
    corner(ctx, POSTER_W - 36, 36, -1, 1);
  }
  if (active.kind === "side") {
    ctx.fillStyle = "#070d14";
    ctx.fillRect(0, 0, 236, 4800);
    ctx.fillStyle = active.accent;
    ctx.fillRect(236, 0, 4, 4800);
  }
  if (active.kind === "glow") {
    const glow = ctx.createRadialGradient(POSTER_W / 2, 160, 20, POSTER_W / 2, 160, 420);
    glow.addColorStop(0, "rgba(124,240,196,0.35)");
    glow.addColorStop(1, "rgba(124,240,196,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, POSTER_W, 520);
  }
  return { canvas, ctx };
}

function corner(ctx: CanvasRenderingContext2D, x: number, y: number, sx: number, sy: number) {
  ctx.strokeStyle = active.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + sy * 28);
  ctx.lineTo(x, y);
  ctx.lineTo(x + sx * 28, y);
  ctx.stroke();
  ctx.lineWidth = 1;
}

export function paintHead(ctx: CanvasRenderingContext2D, date: string, title: string, sub: string): number {
  const left = edge();
  if (active.kind === "red") {
    ctx.fillStyle = active.accent;
    ctx.fillRect(0, 0, POSTER_W, 280);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = `600 72px ${FONT}`;
    ctx.fillText(title, POSTER_W / 2, 120);
    ctx.font = `26px ${FONT}`;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillText(sub, POSTER_W / 2, 186);
    ctx.font = `24px ${FONT}`;
    ctx.fillText(`${date}    赤轨`, POSTER_W / 2, 236);
    ctx.textAlign = "left";
    return 320;
  }
  if (active.kind === "gold") {
    ctx.textAlign = "center";
    ctx.fillStyle = active.accent;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(`赤轨    ${date}`, POSTER_W / 2, 64);
    ctx.fillRect(POSTER_W / 2 - 80, 92, 160, 2);
    ctx.fillStyle = INK;
    ctx.font = `600 68px ${FONT}`;
    ctx.fillText(title, POSTER_W / 2, 156);
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(sub, POSTER_W / 2, 214);
    ctx.textAlign = "left";
    return 270;
  }
  if (active.kind === "glow") {
    ctx.textAlign = "center";
    ctx.fillStyle = active.accent;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(date, POSTER_W / 2, 56);
    ctx.fillStyle = INK;
    ctx.font = `600 76px ${FONT}`;
    ctx.fillText(title, POSTER_W / 2, 140);
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(sub, POSTER_W / 2, 200);
    ctx.textAlign = "left";
    return 260;
  }
  if (active.kind === "term") {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(`赤轨 // ${date}`, left, 48);
    ctx.fillStyle = INK;
    ctx.font = `600 48px ${FONT}`;
    ctx.fillText(`> ${title}`, left, 108);
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(sub, left, 156);
    return 200;
  }
  if (active.kind === "paper") {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(`赤轨    ${date}`, left, 48);
    ctx.fillStyle = INK;
    ctx.font = `600 60px ${FONT}`;
    ctx.fillText(title, left, 118);
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(sub, left, 168);
    return 210;
  }
  if (active.kind === "print") {
    ctx.strokeStyle = active.accent;
    ctx.strokeRect(left, 36, rightEdge() - left, 168);
    ctx.fillStyle = active.accent;
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(`赤轨 / ${date}`, left + 20, 64);
    ctx.fillStyle = INK;
    ctx.font = `600 52px ${FONT}`;
    ctx.fillText(title, left + 20, 112);
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(sub, left + 20, 160);
    return 240;
  }
  if (active.kind === "side") {
    ctx.fillStyle = active.accent;
    ctx.font = `600 40px ${FONT}`;
    ctx.textAlign = "center";
    "赤轨".split("").forEach((char, index) => ctx.fillText(char, 118, 120 + index * 52));
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(date, 118, 280);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `600 56px ${FONT}`;
    ctx.fillText(title, left, 96);
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(sub, left, 150);
    return 200;
  }
  ctx.fillStyle = INK;
  ctx.fillRect(left, 56, 36, 8);
  ctx.fillStyle = RED;
  ctx.fillRect(left + 44, 44, 36, 8);
  ctx.fillStyle = INK;
  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("赤轨", left + 96, 54);
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(date, rightEdge(), 54);
  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 64px ${FONT}`;
  ctx.fillText(title, left, 128);
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText(sub, left, 176);
  return 214;
}

export function paintHairline(ctx: CanvasRenderingContext2D, y: number, x = edge(), end = rightEdge()) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(end, y);
  if (active.kind === "term") {
    ctx.strokeStyle = LINE;
    ctx.setLineDash([2, 6]);
  } else if (active.kind === "gold") {
    ctx.strokeStyle = active.accent;
    ctx.setLineDash([]);
  } else if (active.kind === "print") {
    ctx.strokeStyle = active.accent;
    ctx.setLineDash([1, 4]);
  } else {
    ctx.strokeStyle = LINE;
    ctx.setLineDash([]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
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
  const left = edge();
  const span = rightEdge() - left;
  const stack = active.kind === "red" || active.kind === "side" || active.kind === "term";
  if (stack) {
    let cursor = y;
    for (const card of cards) {
      if (active.kind !== "term") {
        ctx.fillStyle = CARD;
        ctx.fillRect(left, cursor, span, 92);
      }
      ctx.textAlign = "left";
      ctx.fillStyle = MUTED;
      ctx.font = `22px ${FONT}`;
      ctx.fillText(active.kind === "term" ? `:: ${card.label}` : card.label, left + 16, cursor + 30);
      ctx.textAlign = "right";
      ctx.fillStyle = card.color;
      paintSized(ctx, card.value, rightEdge() - 16, cursor + 30, span * 0.48, 32, 18);
      ctx.textAlign = "left";
      ctx.fillStyle = MUTED;
      ctx.font = `18px ${FONT}`;
      ctx.fillText(fit(ctx, card.note, span - 32), left + 16, cursor + 66);
      cursor += active.kind === "term" ? 84 : 104;
    }
    return cursor;
  }
  if (active.kind === "glow") {
    const col = span / cards.length;
    cards.forEach((card, index) => {
      const x = left + index * col + col / 2;
      ctx.textAlign = "center";
      ctx.fillStyle = MUTED;
      ctx.font = `20px ${FONT}`;
      ctx.fillText(card.label, x, y + 18);
      ctx.fillStyle = card.color;
      paintSized(ctx, card.value, x, y + 72, col - 24, 40, 18);
      ctx.fillStyle = MUTED;
      ctx.font = `18px ${FONT}`;
      ctx.fillText(fit(ctx, card.note, col - 24), x, y + 112);
    });
    ctx.textAlign = "left";
    return y + 140;
  }
  const gap = active.kind === "paper" ? 20 : 16;
  const cardW = (span - gap * (cards.length - 1)) / cards.length;
  const inner = cardW - 36;
  ctx.font = `18px ${FONT}`;
  const notes = cards.map((card) => wrapLines(ctx, card.note, inner).slice(0, 2));
  const cardH = 128 + Math.max(...notes.map((lines) => lines.length), 1) * 22;
  const centered = active.kind === "gold";
  cards.forEach((card, index) => {
    const x = left + index * (cardW + gap);
    if (active.kind === "paper") {
      ctx.fillStyle = CARD;
      ctx.fillRect(x, y, cardW, cardH);
    } else if (active.kind === "gold") {
      ctx.strokeStyle = active.accent;
      ctx.strokeRect(x + 0.5, y + 0.5, cardW - 1, cardH - 1);
      ctx.strokeRect(x + 5.5, y + 5.5, cardW - 11, cardH - 11);
    } else {
      ctx.fillStyle = CARD;
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = active.kind === "print" ? active.accent : LINE;
      ctx.strokeRect(x + 0.5, y + 0.5, cardW - 1, cardH - 1);
    }
    if (active.kind === "print") {
      ctx.fillStyle = active.accent;
      ctx.font = `18px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText(String(index + 1).padStart(2, "0"), x + 16, y + 22);
    }
    ctx.fillStyle = MUTED;
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = centered ? "center" : "left";
    ctx.fillText(card.label, centered ? x + cardW / 2 : x + 16, y + 46);
    ctx.fillStyle = card.color;
    paintSized(ctx, card.value, centered ? x + cardW / 2 : x + 16, y + 88, inner, 34, 16);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT}`;
    notes[index].forEach((line, lineIndex) => ctx.fillText(line, centered ? x + cardW / 2 : x + 16, y + 124 + lineIndex * 22));
  });
  ctx.textAlign = "left";
  return y + cardH;
}

export function paintSection(ctx: CanvasRenderingContext2D, y: number, label: string, color: string, x = edge()): number {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (active.kind === "term") {
    ctx.fillStyle = color;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(`## ${label}`, x, y + 14);
    return y + 40;
  }
  if (active.kind === "gold" || active.kind === "glow") {
    ctx.fillStyle = active.kind === "gold" ? active.accent : color;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(label, x, y + 14);
    ctx.fillRect(x, y + 32, 72, 2);
    return y + 52;
  }
  if (active.kind === "red") {
    ctx.fillStyle = active.accent;
    ctx.fillRect(x, y, rightEdge() - x, 40);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(label, x + 16, y + 20);
    return y + 56;
  }
  if (active.kind === "print") {
    ctx.fillStyle = active.accent;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(`// ${label}`, x, y + 14);
    return y + 44;
  }
  if (active.kind === "paper") {
    ctx.fillStyle = INK;
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(label, x, y + 14);
    return y + 44;
  }
  ctx.fillStyle = color;
  ctx.fillRect(x, y + 8, 18, 4);
  ctx.fillStyle = INK;
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText(label, x + 28, y + 12);
  return y + 40;
}

export function paintFoot(ctx: CanvasRenderingContext2D, y: number, note: string): number {
  const left = edge();
  paintHairline(ctx, y, left, rightEdge());
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `22px ${FONT}`;
  const lines = wrapLines(ctx, note, rightEdge() - left);
  lines.forEach((line, index) => ctx.fillText(line, left, y + 36 + index * 30));
  const foot = y + 36 + lines.length * 30;
  ctx.font = `20px ${FONT}`;
  ctx.fillText(active.kind === "term" ? `// 赤轨 ${active.name}  复盘用  不是买卖依据` : `赤轨 · ${active.name} · 复盘用 · 不是买卖依据`, left, foot + 8);
  return foot + 44;
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
