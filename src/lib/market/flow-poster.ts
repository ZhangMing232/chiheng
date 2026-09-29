import type { FlowBook, FlowRow, MarketPart } from "./flow";
import { FONT, GREEN, INK, LINE, MUTED, POSTER_W, RED, beginPoster, openPoster, paintMark, paintTitle, themeName } from "./poster";
import { paintCards, paintSized, wrapLines } from "./poster";

const W = POSTER_W;

function absWan(wan: number): string {
  const abs = Math.abs(wan);
  if (!Number.isFinite(abs)) return "—";
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

function tone(wan: number): string {
  if (wan > 0) return RED;
  if (wan < 0) return GREEN;
  return INK;
}

function netText(wan: number): string {
  if (wan > 0) return `净流入 ${absWan(wan)}`;
  if (wan < 0) return `净流出 ${absWan(wan)}`;
  return "持平";
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日`;
}

function fileDate(at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let next = text;
  while (next.length > 1 && ctx.measureText(`${next}…`).width > max) next = next.slice(0, -1);
  return `${next}…`;
}

/** 资金页汇总图。红是净流入，绿是净流出。 */
export function drawFlowPoster(book: FlowBook): { canvas: HTMLCanvasElement; filename: string } {
  const amount = book.tape.reduce((sum, row) => sum + row.amount, 0);
  const prev = book.tape.every((row) => row.prevAmount != null) ? book.tape.reduce((sum, row) => sum + (row.prevAmount ?? 0), 0) : null;
  const delta = prev == null ? null : amount - prev;
  const main = book.market.reduce((sum, part) => sum + part.main, 0);
  const keys: { label: string; key: keyof Omit<MarketPart, "name"> }[] = [
    { label: "主力", key: "main" },
    { label: "超大单", key: "super" },
    { label: "大单", key: "big" },
    { label: "中单", key: "mid" },
    { label: "小单", key: "small" },
    { label: "散户", key: "retail" },
  ];
  const showTable = book.market.length > 0;
  beginPoster();
  const { canvas, ctx } = openPoster();

  paintMark(ctx, headline(book.asOf));
  paintTitle(ctx, "资金汇总", "红是净流入    绿是净流出");

  const cards: { label: string; value: string; color: string; note: string }[] = [
    {
      label: "成交额",
      value: amount > 0 ? absWan(amount) : "—",
      color: INK,
      note: book.tape.map((row) => `${row.name} ${absWan(row.amount)}`).join("  ") || "上证与深成",
    },
    {
      label: delta == null ? "较昨日" : delta > 0 ? "放量" : delta < 0 ? "缩量" : "持平",
      value: delta == null ? "—" : absWan(delta),
      color: delta == null || delta === 0 ? INK : delta > 0 ? RED : GREEN,
      note: "比上一交易日",
    },
    {
      label: book.market.length ? (main > 0 ? "主力净流入" : main < 0 ? "主力净流出" : "主力") : "主力",
      value: book.market.length ? absWan(main) : "—",
      color: book.market.length ? tone(main) : INK,
      note: amount > 0 && book.market.length ? `占成交额 ${((Math.abs(main) / amount) * 100).toFixed(2)}%` : "暂无",
    },
  ];
  let y = paintCards(ctx, 212, cards) + 28;
  if (showTable) {
    y = sectionTitle(ctx, y, "成分");
    const cols = ["合计", ...book.market.map((part) => part.name)];
    const colW = (W - 112 - 140) / cols.length;
    ctx.fillStyle = MUTED;
    ctx.font = `20px ${FONT}`;
    cols.forEach((name, index) => {
      ctx.textAlign = "right";
      ctx.fillText(name, 196 + colW * (index + 1) - 8, y + 22);
    });
    y += 48;
    for (const row of keys) {
      ctx.strokeStyle = LINE;
      ctx.beginPath();
      ctx.moveTo(56, y);
      ctx.lineTo(W - 56, y);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = row.key === "main" || row.key === "retail" ? INK : MUTED;
      ctx.font = `${row.key === "main" || row.key === "retail" ? 600 : 400} 24px ${FONT}`;
      ctx.fillText(row.label, 56, y + 26);
      const values = [book.market.reduce((sum, part) => sum + part[row.key], 0), ...book.market.map((part) => part[row.key])];
      values.forEach((value, index) => {
        ctx.textAlign = "right";
        ctx.fillStyle = tone(value);
        paintSized(ctx, netText(value), 196 + colW * (index + 1) - 8, y + 26, colW - 16, 24, 16);
      });
      y += 52;
    }
  }

  y += 28;
  y = pair(ctx, y, "行业流入", book.sectorsIn, "行业流出", book.sectorsOut);
  y += 20;
  y = pair(ctx, y, "个股流入", book.stocksIn, "个股流出", book.stocksOut);

  y += 36;
  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(56, y);
  ctx.lineTo(W - 56, y);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
  ctx.font = `22px ${FONT}`;
  const north = book.north.length
    ? book.north.map((leg) => `${leg.name} 成交额 ${absWan(leg.amount)}`).join("    ") + "    净流入不公布"
    : "北向成交额暂时没有    净流入不公布";
  const northLines = wrapLines(ctx, north, W - 112);
  northLines.forEach((line, index) => ctx.fillText(line, 56, y + 36 + index * 30));
  const foot = y + 36 + northLines.length * 30;
  ctx.fillStyle = "#5d6b7c";
  ctx.font = `20px ${FONT}`;
  ctx.fillText(`赤轨 · ${themeName()} · 复盘用 · 不是买卖依据`, 56, foot + 8);

  const height = foot + 48;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = height;
  const next = out.getContext("2d");
  if (!next) throw new Error("画布不可用");
  next.drawImage(canvas, 0, 0, W, height, 0, 0, W, height);
  return { canvas: out, filename: `赤轨-资金-${themeName()}-${fileDate(book.asOf)}.png` };
}

function sectionTitle(ctx: CanvasRenderingContext2D, y: number, title: string): number {
  ctx.fillStyle = RED;
  ctx.fillRect(56, y + 8, 18, 4);
  ctx.fillStyle = INK;
  ctx.font = `600 26px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, 84, y + 12);
  return y + 40;
}

function pair(ctx: CanvasRenderingContext2D, y: number, left: string, leftRows: FlowRow[], right: string, rightRows: FlowRow[]): number {
  const colW = (W - 112 - 24) / 2;
  const rightX = 56 + colW + 24;
  y = Math.max(sectionTitle(ctx, y, left), sectionTitleAt(ctx, y, right, rightX));
  for (let index = 0; index < 6; index += 1) {
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(56 + colW, y);
    ctx.moveTo(rightX, y);
    ctx.lineTo(W - 56, y);
    ctx.stroke();
    entry(ctx, 56, y, colW, index, leftRows[index]);
    entry(ctx, rightX, y, colW, index, rightRows[index]);
    y += 52;
  }
  return y;
}

function sectionTitleAt(ctx: CanvasRenderingContext2D, y: number, title: string, x: number): number {
  ctx.fillStyle = GREEN;
  ctx.fillRect(x, y + 8, 18, 4);
  ctx.fillStyle = INK;
  ctx.font = `600 26px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(title, x + 28, y + 12);
  return y + 40;
}

function entry(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, index: number, row: FlowRow | undefined) {
  ctx.textBaseline = "middle";
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#5d6b7c";
  ctx.fillText(String(index + 1).padStart(2, "0"), x, y + 26);
  if (!row) {
    ctx.fillStyle = "#5d6b7c";
    ctx.fillText("—", x + 44, y + 26);
    return;
  }
  ctx.font = `24px ${FONT}`;
  ctx.fillStyle = INK;
  paintSized(ctx, row.name, x + 44, y + 26, width * 0.48, 24, 16);
  ctx.textAlign = "right";
  ctx.fillStyle = tone(row.inflow);
  paintSized(ctx, netText(row.inflow), x + width, y + 26, width * 0.48, 24, 16);
}
