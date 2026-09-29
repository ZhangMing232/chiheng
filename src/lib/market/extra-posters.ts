import type { FutBook } from "./index-futures";
import type { HotBook } from "./hotmoney";
import {
  GREEN,
  INK,
  LINE,
  MUTED,
  POSTER_W,
  RED,
  cropPoster,
  dayFromDate,
  fileDate,
  fit,
  openPoster,
  paintCards,
  paintFoot,
  paintMark,
  paintSection,
  paintTitle,
} from "./poster";

function wan(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${Math.round(abs)}万`;
  return `${abs.toFixed(1)}万`;
}

function lots(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `${(abs / 10000).toFixed(2)}万手`;
  return `${Math.round(abs)}手`;
}

const FACE = '"PingFang SC","Hiragino Sans GB","WenQuanYi Zen Hei","Noto Sans SC",sans-serif';

export function drawHotPoster(book: HotBook) {
  const width = 1080;
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("画布不可用");
  probe.font = `28px ${FACE}`;
  const labelW = 210;
  const textW = width - labelW - 72;
  const rows = book.seats.map((seat) => ({
    name: seat.name,
    lines: wrapStocks(probe, seat.stocks, textW),
  }));
  const lineH = 40;
  const headerH = 132;
  const body = rows.reduce((sum, row) => sum + Math.max(72, row.lines.length * lineH + 28), 0);
  const height = headerH + body + 56;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画布不可用");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e10600";
  ctx.fillRect(0, 0, width, headerH);
  ctx.fillStyle = "#fff";
  ctx.font = `700 56px ${FACE}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${dayFromDate(book.date || fileDate(""))}游资龙虎榜`, width / 2, 58);
  ctx.font = `24px ${FACE}`;
  ctx.fillStyle = "#ffe08a";
  ctx.fillText("红是净买    绿是净卖", width / 2, 104);

  let y = headerH;
  for (const row of rows) {
    const h = Math.max(72, row.lines.length * lineH + 28);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, y, width, h);
    ctx.strokeStyle = "#f0c4c4";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, y + h);
    ctx.lineTo(width - 28, y + h);
    ctx.stroke();
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `700 30px ${FACE}`;
    ctx.textAlign = "center";
    ctx.fillText(fit(ctx, row.name, labelW - 24), labelW / 2, y + h / 2);
    ctx.textAlign = "left";
    ctx.font = `28px ${FACE}`;
    row.lines.forEach((line, index) => {
      let x = labelW + 12;
      const ly = y + 22 + lineH / 2 + index * lineH;
      for (const piece of line) {
        ctx.fillStyle = piece.color;
        ctx.fillText(piece.text, x, ly);
        x += ctx.measureText(piece.text).width;
      }
    });
    y += h;
  }
  ctx.strokeStyle = "#e10600";
  ctx.lineWidth = 18;
  ctx.strokeRect(9, 9, width - 18, height - 18);
  return { canvas, filename: `赤轨-游资-${fileDate(book.date || "")}.png` };
}

function wrapStocks(ctx: CanvasRenderingContext2D, stocks: { name: string; netWan: number }[], maxWidth: number): { text: string; color: string }[][] {
  const pieces = stocks.map((stock) => ({
    text: `${stock.name} ${stock.netWan > 0 ? "净买" : "净卖"}${wan(stock.netWan)}   `,
    color: stock.netWan > 0 ? "#e10600" : "#12823a",
  }));
  const lines: { text: string; color: string }[][] = [[]];
  let used = 0;
  for (const piece of pieces) {
    const w = ctx.measureText(piece.text).width;
    const line = lines[lines.length - 1];
    if (line.length > 0 && used + w > maxWidth) {
      lines.push([piece]);
      used = w;
    } else {
      line.push(piece);
      used += w;
    }
  }
  return lines.filter((line) => line.length > 0);
}

export function drawFuturesPoster(book: FutBook) {
  const { canvas, ctx } = openPoster();
  const date = book.date || fileDate("");
  paintMark(ctx, dayFromDate(date));
  paintTitle(ctx, "股指期货持仓", "前20名会员多单和空单。公布的是代客，不是机构专户。");
  const cards = book.rows.slice(0, 4).map((row) => {
    const net = row.longLots - row.shortLots;
    return {
      label: row.name,
      value: net > 0 ? `净多 ${lots(net)}` : net < 0 ? `净空 ${lots(net)}` : "持平",
      color: net > 0 ? RED : net < 0 ? GREEN : INK,
      note: row.contract,
    };
  });
  let y = paintCards(ctx, 212, cards.length ? cards : [{ label: "持仓", value: "—", color: INK, note: "暂时没有" }]);
  y += 28;
  y = paintSection(ctx, y, "主力合约", RED);
  ctx.font = `20px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("多单", 620, y + 8);
  ctx.fillText("空单", 820, y + 8);
  ctx.fillText("净持仓", POSTER_W - 56, y + 8);
  y += 36;
  for (const row of book.rows) {
    const net = row.longLots - row.shortLots;
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(POSTER_W - 56, y);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `24px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
    ctx.fillText(`${row.name} ${row.contract}`, 56, y + 26);
    ctx.textAlign = "right";
    ctx.fillStyle = RED;
    ctx.fillText(lots(row.longLots), 620, y + 26);
    ctx.fillStyle = GREEN;
    ctx.fillText(lots(row.shortLots), 820, y + 26);
    ctx.fillStyle = net > 0 ? RED : net < 0 ? GREEN : INK;
    ctx.fillText(net > 0 ? `净多 ${lots(net)}` : net < 0 ? `净空 ${lots(net)}` : "持平", POSTER_W - 56, y + 26);
    y += 52;
    ctx.font = `20px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    const longLine = row.longTop.map((item) => `${item.name} ${lots(item.lots)}`).join("  ");
    const shortLine = row.shortTop.map((item) => `${item.name} ${lots(item.lots)}`).join("  ");
    ctx.fillText(fit(ctx, `多 ${longLine}`, POSTER_W - 112), 56, y + 8);
    y += 32;
    ctx.fillText(fit(ctx, `空 ${shortLine}`, POSTER_W - 112), 56, y + 8);
    y += 40;
  }
  y = paintFoot(ctx, y, "单位是手。净持仓是前20名多单合计减去空单合计。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-期指-${fileDate(date)}.png` };
}
