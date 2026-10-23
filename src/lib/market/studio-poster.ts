/**
 * 这个文件是干什么的：
 * 自媒体图文里的「每日复盘」配图。把指数、涨跌分布、资金画成一张海报。
 *
 * 你需要知道的：
 * 复用 poster.ts 的画笔（8 套主题），画布宽 1080、先画高再裁到内容高度。
 * 红涨绿跌。数字不构成投资建议。
 */

import type { FlowBook } from "./flow.ts";
import type { IndexQuote } from "./types.ts";
import type { Breadth } from "./slim-universe.ts";
import {
  FONT,
  GREEN,
  INK,
  MUTED,
  POSTER_W,
  RED,
  beginPoster,
  edge,
  openPoster,
  paintCards,
  paintFoot,
  paintHairline,
  paintHead,
  paintSection,
  paintSized,
  rightEdge,
  themeName,
} from "./poster.ts";

const W = POSTER_W;

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
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

/** 每日复盘海报。 */
export function drawDailyPoster(input: { indices: IndexQuote[]; breadth: Breadth; flow: FlowBook | null }): { canvas: HTMLCanvasElement; filename: string } {
  const { indices, breadth, flow } = input;
  const total = breadth.up + breadth.down + breadth.flat;
  const amount = flow?.tape.reduce((sum, row) => sum + row.amount, 0) ?? 0;
  const main = flow?.market.reduce((sum, part) => sum + part.main, 0) ?? 0;
  const north = flow?.north.reduce((sum, leg) => sum + leg.amount, 0) ?? 0;

  beginPoster();
  const { canvas, ctx } = openPoster();
  const left = edge();
  const right = rightEdge();

  const cards = [
    { label: "上涨", value: String(breadth.up), color: RED, note: total > 0 ? `${((breadth.up / total) * 100).toFixed(1)}%` : "—" },
    { label: "下跌", value: String(breadth.down), color: GREEN, note: total > 0 ? `${((breadth.down / total) * 100).toFixed(1)}%` : "—" },
    { label: "成交额", value: amount > 0 ? absWan(amount) : "—", color: INK, note: flow?.tape.map((row) => `${row.name} ${absWan(row.amount)}`).join("  ") || "两市" },
  ];
  let y = paintHead(ctx, headline(flow?.asOf ?? Date.now()), "每日复盘", "红涨绿跌    数据不构成投资建议");
  y = paintCards(ctx, y + 16, cards) + 24;

  // 指数
  y = paintSection(ctx, y, "指数", RED);
  const colW = (right - left - 24) / 2;
  for (let i = 0; i < Math.min(indices.length, 6); i += 1) {
    const item = indices[i];
    const x = i % 2 === 0 ? left : left + colW + 24;
    const yy = y + Math.floor(i / 2) * 52;
    paintHairline(ctx, yy, x, x + colW);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = INK;
    paintSized(ctx, item.name, x, yy + 26, colW * 0.5, 22, 16);
    ctx.textAlign = "right";
    ctx.font = `24px ${FONT}`;
    ctx.fillStyle = tone(item.pct);
    paintSized(ctx, `${item.price.toFixed(2)}  ${pct(item.pct)}`, x + colW, yy + 26, colW * 0.5, 24, 16);
  }
  y += Math.ceil(Math.min(indices.length, 6) / 2) * 52 + 28;

  // 涨跌分布
  y = paintSection(ctx, y, "涨跌分布", INK);
  const dist = `上涨 ${breadth.up} · 下跌 ${breadth.down} · 平盘 ${breadth.flat} · 涨停 ${breadth.limitUp} · 跌停 ${breadth.limitDown}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `24px ${FONT}`;
  ctx.fillStyle = INK;
  paintSized(ctx, dist, left, y + 30, right - left, 24, 18);
  y += 76;

  const foot = paintFoot(ctx, y, `主力 ${absWan(main)}    北向成交额 ${absWan(north)}    净流入不公布`);
  const height = foot + 48;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = height;
  const next = out.getContext("2d");
  if (!next) throw new Error("画布不可用");
  next.drawImage(canvas, 0, 0, W, height, 0, 0, W, height);
  return { canvas: out, filename: `赤轨-复盘-${themeName()}-${headline(flow?.asOf ?? Date.now())}.png` };
}

export { absWan };
