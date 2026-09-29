/**
 * 这个文件是干什么的：
 * 画两张海报：游资龙虎榜，和股指期货持仓。
 *
 * 你需要知道的：
 * 游资图红是净买、绿是净卖，金额按万元。期指图单位是手，红是净多、绿是净空。
 */

import type { FutBook } from "./index-futures";
import type { HotBook } from "./hotmoney";
import {
  GREEN,
  INK,
  MUTED,
  RED,
  beginPoster,
  cropPoster,
  dayFromDate,
  edge,
  fileDate,
  openPoster,
  paintCards,
  paintFoot,
  paintHairline,
  paintHead,
  paintSection,
  rightEdge,
  themeName,
  wrapLines,
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

/** 画游资龙虎榜。传入当天席位账，返回画布和文件名。一行一个席位，旁边写净买或净卖（万元）。 */
export function drawHotPoster(book: HotBook) {
  beginPoster();
  const { canvas, ctx } = openPoster();
  const date = book.date || fileDate("");
  const left = edge();
  const right = rightEdge();
  let y = paintHead(ctx, dayFromDate(date), "游资龙虎榜", "红是净买    绿是净卖");
  const labelW = 220;
  const textX = left + labelW;
  const textW = right - textX;
  for (const seat of book.seats) {
    ctx.font = `26px ${FACE}`;
    const nameLines = wrapLines(ctx, seat.name, labelW - 20);
    const stockLines = wrapStocks(ctx, seat.stocks, textW);
    const h = Math.max(nameLines.length * 36, stockLines.length * 40, 40) + 28;
    paintHairline(ctx, y, left, right);
    ctx.fillStyle = INK;
    ctx.font = `26px ${FACE}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    nameLines.forEach((line, index) => ctx.fillText(line, left, y + 28 + index * 36));
    stockLines.forEach((line, index) => {
      let x = textX;
      const ly = y + 28 + index * 40;
      for (const piece of line) {
        ctx.fillStyle = piece.color;
        ctx.font = `26px ${FACE}`;
        ctx.fillText(piece.text, x, ly);
        x += ctx.measureText(piece.text).width;
      }
    });
    y += h;
  }
  y = paintFoot(ctx, y + 12, "一行一个席位。对得上营业部的才用别名。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-游资-${themeName()}-${fileDate(date)}.png` };
}

function wrapStocks(ctx: CanvasRenderingContext2D, stocks: { name: string; netWan: number }[], maxWidth: number): { text: string; color: string }[][] {
  const pieces = stocks.map((stock) => ({
    text: `${stock.name} ${stock.netWan > 0 ? "净买" : "净卖"}${wan(stock.netWan)}   `,
    color: stock.netWan > 0 ? RED : GREEN,
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

/** 画股指期货持仓。传入持仓账，返回画布和文件名。多单红、空单绿，单位是手。 */
export function drawFuturesPoster(book: FutBook) {
  beginPoster();
  const { canvas, ctx } = openPoster();
  const date = book.date || fileDate("");
  const left = edge();
  const right = rightEdge();
  let y = paintHead(ctx, dayFromDate(date), "股指期货持仓", "前20名会员多单和空单。公布的是代客，不是机构专户。");
  const cards = book.rows.slice(0, 4).map((row) => {
    const net = row.longLots - row.shortLots;
    return {
      label: row.name,
      value: net > 0 ? `净多 ${lots(net)}` : net < 0 ? `净空 ${lots(net)}` : "持平",
      color: net > 0 ? RED : net < 0 ? GREEN : INK,
      note: row.contract,
    };
  });
  y = paintCards(ctx, y + 16, cards.length ? cards : [{ label: "持仓", value: "—", color: INK, note: "暂时没有" }]);
  y += 24;
  y = paintSection(ctx, y, "主力合约", RED);
  const span = right - left;
  ctx.font = `20px ${FACE}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "right";
  ctx.fillText("多单", left + span * 0.52, y + 8);
  ctx.fillText("空单", left + span * 0.74, y + 8);
  ctx.fillText("净持仓", right, y + 8);
  y += 36;
  for (const row of book.rows) {
    const net = row.longLots - row.shortLots;
    paintHairline(ctx, y, left, right);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `24px ${FACE}`;
    ctx.fillText(`${row.name} ${row.contract}`, left, y + 26);
    ctx.textAlign = "right";
    ctx.fillStyle = RED;
    ctx.fillText(lots(row.longLots), left + span * 0.52, y + 26);
    ctx.fillStyle = GREEN;
    ctx.fillText(lots(row.shortLots), left + span * 0.74, y + 26);
    ctx.fillStyle = net > 0 ? RED : net < 0 ? GREEN : INK;
    ctx.fillText(net > 0 ? `净多 ${lots(net)}` : net < 0 ? `净空 ${lots(net)}` : "持平", right, y + 26);
    y += 52;
    ctx.font = `20px ${FACE}`;
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    const longLine = `多 ${row.longTop.map((item) => `${item.name} ${lots(item.lots)}`).join("  ")}`;
    const shortLine = `空 ${row.shortTop.map((item) => `${item.name} ${lots(item.lots)}`).join("  ")}`;
    for (const line of wrapLines(ctx, longLine, span)) {
      ctx.fillText(line, left, y + 8);
      y += 28;
    }
    for (const line of wrapLines(ctx, shortLine, span)) {
      ctx.fillText(line, left, y + 8);
      y += 28;
    }
    y += 12;
  }
  y = paintFoot(ctx, y, "单位是手。净持仓是前20名多单合计减去空单合计。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-期指-${themeName()}-${fileDate(date)}.png` };
}
