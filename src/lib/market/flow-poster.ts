import type { FlowBook, FlowRow, MarketPart } from "./flow";

const W = 1080;
const RED = "#e10600";
const GREEN = "#12823a";
const INK = "#1a1a1a";
const FONT = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

type Piece = { text: string; color: string };
type PosterRow = { label: string; pieces: Piece[] };

function absWan(wan: number): string {
  const abs = Math.abs(wan);
  if (!Number.isFinite(abs)) return "—";
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

function netPiece(wan: number): Piece {
  if (wan > 0) return { text: `净流入${absWan(wan)}`, color: RED };
  if (wan < 0) return { text: `净流出${absWan(wan)}`, color: GREEN };
  return { text: "持平", color: INK };
}

function gap(): Piece {
  return { text: "    ", color: INK };
}

function headline(at: number): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(at));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}月${day}日 资金汇总`;
}

function fileDate(at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function names(rows: FlowRow[], limit: number): Piece[] {
  const pieces: Piece[] = [];
  for (const row of rows.slice(0, limit)) {
    if (pieces.length) pieces.push(gap());
    pieces.push({ text: row.name, color: INK });
    pieces.push({ text: " ", color: INK });
    pieces.push(netPiece(row.inflow));
  }
  return pieces.length ? pieces : [{ text: "没有数据", color: "#888" }];
}

function partLine(parts: MarketPart[], key: keyof Omit<MarketPart, "name">): Piece[] {
  const total = parts.reduce((sum, part) => sum + part[key], 0);
  const pieces: Piece[] = [{ text: "合计 ", color: INK }, netPiece(total)];
  for (const part of parts) {
    pieces.push(gap(), { text: `${part.name} `, color: INK }, netPiece(part[key]));
  }
  return pieces;
}

function rowsOf(book: FlowBook): PosterRow[] {
  const amount = book.tape.reduce((sum, row) => sum + row.amount, 0);
  const prev = book.tape.every((row) => row.prevAmount != null) ? book.tape.reduce((sum, row) => sum + (row.prevAmount ?? 0), 0) : null;
  const delta = prev == null ? null : amount - prev;
  const tape: Piece[] = [{ text: `成交额 ${amount > 0 ? absWan(amount) : "—"}`, color: INK }];
  if (delta != null) {
    tape.push(gap(), {
      text: `${delta > 0 ? "放量" : delta < 0 ? "缩量" : "持平"} ${absWan(delta)}`,
      color: delta > 0 ? RED : delta < 0 ? GREEN : INK,
    });
  }
  const main = book.market.reduce((sum, part) => sum + part.main, 0);
  if (book.market.length) tape.push(gap(), { text: "主力 ", color: INK }, netPiece(main));

  const keys: { label: string; key: keyof Omit<MarketPart, "name"> }[] = [
    { label: "主力", key: "main" },
    { label: "超大单", key: "super" },
    { label: "大单", key: "big" },
    { label: "中单", key: "mid" },
    { label: "小单", key: "small" },
    { label: "散户", key: "retail" },
  ];

  const north: Piece[] = book.north.length
    ? book.north.flatMap((leg, index) => {
        const piece = [{ text: `${leg.name} 成交额${absWan(leg.amount)}`, color: INK }];
        return index === 0 ? piece : [gap(), ...piece];
      })
    : [{ text: "成交额暂时没有", color: "#888" }];
  north.push(gap(), { text: "净流入不公布", color: "#888" });

  return [
    { label: "大盘", pieces: tape },
    ...(book.market.length ? keys.map((row) => ({ label: row.label, pieces: partLine(book.market, row.key) })) : []),
    { label: "行业流入", pieces: names(book.sectorsIn, 8) },
    { label: "行业流出", pieces: names(book.sectorsOut, 8) },
    { label: "个股流入", pieces: names(book.stocksIn, 8) },
    { label: "个股流出", pieces: names(book.stocksOut, 8) },
    { label: "北向", pieces: north },
  ];
}

function wrap(ctx: CanvasRenderingContext2D, pieces: Piece[], maxWidth: number): Piece[][] {
  const lines: Piece[][] = [[]];
  let used = 0;
  for (const piece of pieces) {
    const width = ctx.measureText(piece.text).width;
    const line = lines[lines.length - 1];
    if (line.length > 0 && used + width > maxWidth) {
      lines.push([piece]);
      used = width;
    } else {
      line.push(piece);
      used += width;
    }
  }
  return lines.filter((line) => line.length > 0);
}

/** 资金页汇总图。红是净流入，绿是净流出。 */
export function drawFlowPoster(book: FlowBook): { canvas: HTMLCanvasElement; filename: string } {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("画布不可用");
  probe.font = `32px ${FONT}`;
  const labelW = 188;
  const padX = 28;
  const contentX = padX + labelW;
  const contentW = W - contentX - padX - 8;
  const rows = rowsOf(book).map((row) => ({ ...row, lines: wrap(probe, row.pieces, contentW) }));
  const lineH = 46;
  const rowPad = 18;
  const headerH = 148;
  const footerH = 64;
  const bodyH = rows.reduce((sum, row) => sum + Math.max(lineH, row.lines.length * lineH) + rowPad * 2, 0);
  const H = headerH + bodyH + footerH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = RED;
  ctx.fillRect(0, 0, W, headerH);
  ctx.fillStyle = "#fff";
  ctx.font = `bold 64px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(headline(book.asOf), W / 2, 62);
  ctx.font = `28px ${FONT}`;
  ctx.fillStyle = "#ffe08a";
  ctx.fillText("红是净流入    绿是净流出", W / 2, 112);

  let y = headerH;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const row of rows) {
    const h = Math.max(lineH, row.lines.length * lineH) + rowPad * 2;
    ctx.fillStyle = "#fff5f5";
    ctx.fillRect(0, y, labelW + padX, h);
    ctx.strokeStyle = "#f0d0d0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + h);
    ctx.lineTo(W, y + h);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(row.label, padX, y + h / 2);
    ctx.font = `32px ${FONT}`;
    row.lines.forEach((line, index) => {
      let x = contentX;
      const ly = y + rowPad + lineH / 2 + index * lineH;
      for (const piece of line) {
        ctx.fillStyle = piece.color;
        ctx.fillText(piece.text, x, ly);
        x += ctx.measureText(piece.text).width;
      }
    });
    y += h;
  }

  ctx.fillStyle = "#111";
  ctx.fillRect(0, H - footerH, W, footerH);
  ctx.fillStyle = "#ffe08a";
  ctx.font = `26px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("赤轨 · 复盘用 · 不是买卖依据", W / 2, H - footerH / 2);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  return { canvas, filename: `赤轨-资金-${fileDate(book.asOf)}.png` };
}
