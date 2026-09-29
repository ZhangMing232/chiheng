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

export function drawHotPoster(book: HotBook) {
  const { canvas, ctx } = openPoster();
  const date = book.date || fileDate("");
  paintMark(ctx, dayFromDate(date));
  paintTitle(ctx, "游资龙虎榜", "红是净买入，绿是净卖出。机构席位不在这里。");
  let y = paintCards(ctx, 212, [
    { label: "净买入", value: String(book.buys.length), color: RED, note: "席位" },
    { label: "净卖出", value: String(book.sells.length), color: GREEN, note: "席位" },
    { label: "日期", value: dayFromDate(date), color: INK, note: "收盘后公布" },
  ]);
  y += 28;
  const colW = (POSTER_W - 112 - 24) / 2;
  const rightX = 56 + colW + 24;
  paintSection(ctx, y, "买入", RED, 56);
  y = paintSection(ctx, y, "卖出", GREEN, rightX);
  const n = Math.max(book.buys.length, book.sells.length, 1);
  for (let index = 0; index < Math.min(n, 8); index += 1) {
    const h = 108;
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(56 + colW, y);
    ctx.moveTo(rightX, y);
    ctx.lineTo(POSTER_W - 56, y);
    ctx.stroke();
    seat(ctx, 56, y, colW, book.buys[index]);
    seat(ctx, rightX, y, colW, book.sells[index]);
    y += h;
  }
  y = paintFoot(ctx, y + 8, "一只股票可能因多个上榜原因被重复统计，已按席位加总。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-游资-${fileDate(date)}.png` };
}

function seat(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, row?: { name: string; netWan: number; stocks: { name: string; netWan: number }[] }) {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (!row) {
    ctx.fillStyle = MUTED;
    ctx.font = `22px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
    ctx.fillText("—", x, y + 28);
    return;
  }
  ctx.fillStyle = INK;
  ctx.font = `600 24px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
  ctx.fillText(fit(ctx, row.name, width * 0.62), x, y + 24);
  ctx.textAlign = "right";
  ctx.fillStyle = row.netWan > 0 ? RED : GREEN;
  ctx.fillText(row.netWan > 0 ? `净买 ${wan(row.netWan)}` : `净卖 ${wan(row.netWan)}`, x + width, y + 24);
  ctx.textAlign = "left";
  ctx.font = `20px "PingFang SC","WenQuanYi Zen Hei",sans-serif`;
  const line = row.stocks
    .map((stock) => `${stock.name} ${stock.netWan > 0 ? "净买" : "净卖"}${wan(stock.netWan)}`)
    .join("  ");
  ctx.fillStyle = MUTED;
  ctx.fillText(fit(ctx, line || "—", width), x, y + 64);
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
