import type { FlowBook, FlowRow, MarketPart } from "./flow";

const W = 1080;
const RED = "#f0535e";
const GREEN = "#2fbf8a";
const INK = "#e8eef6";
const MUTED = "#8b97a8";
const LINE = "#243044";
const CARD = "#121820";
const FONT = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

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
  const H = 2200;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");

  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#101820";
  ctx.lineWidth = 1;
  for (let x = 80; x < W; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  ctx.fillStyle = INK;
  ctx.fillRect(56, 56, 36, 8);
  ctx.fillStyle = RED;
  ctx.fillRect(100, 44, 36, 8);

  ctx.fillStyle = INK;
  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("赤轨", 152, 54);
  ctx.fillStyle = MUTED;
  ctx.font = `26px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(headline(book.asOf), W - 56, 54);

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 64px ${FONT}`;
  ctx.fillText("资金汇总", 56, 128);
  ctx.fillStyle = MUTED;
  ctx.font = `24px ${FONT}`;
  ctx.fillText("红是净流入    绿是净流出", 56, 176);

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
  const gap = 16;
  const cardW = (W - 112 - gap * 2) / 3;
  cards.forEach((card, index) => {
    const x = 56 + index * (cardW + gap);
    ctx.fillStyle = CARD;
    ctx.fillRect(x, 212, cardW, 148);
    ctx.strokeStyle = LINE;
    ctx.strokeRect(x + 0.5, 212.5, cardW - 1, 147);
    ctx.fillStyle = MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(card.label, x + 20, 240);
    ctx.fillStyle = card.color;
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(fit(ctx, card.value, cardW - 36), x + 20, 288);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(fit(ctx, card.note, cardW - 36), x + 20, 328);
  });

  let y = 392;
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
        ctx.font = `24px ${FONT}`;
        ctx.fillText(fit(ctx, netText(value), colW - 16), 196 + colW * (index + 1) - 8, y + 26);
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
  ctx.fillText(fit(ctx, north, W - 112), 56, y + 36);
  ctx.fillStyle = "#5d6b7c";
  ctx.font = `20px ${FONT}`;
  ctx.fillText("赤轨 · 复盘用 · 不是买卖依据", 56, y + 72);

  const height = y + 108;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = height;
  const next = out.getContext("2d");
  if (!next) throw new Error("画布不可用");
  next.drawImage(canvas, 0, 0, W, height, 0, 0, W, height);
  return { canvas: out, filename: `赤轨-资金-${fileDate(book.asOf)}.png` };
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
  ctx.fillText(fit(ctx, row.name, width * 0.46), x + 44, y + 26);
  ctx.textAlign = "right";
  ctx.fillStyle = tone(row.inflow);
  ctx.fillText(netText(row.inflow), x + width, y + 26);
}
