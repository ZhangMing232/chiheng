import { fmtPrice, signedPct } from "./format";
import type { NewsTone, StockArticle } from "./news";
import {
  FONT,
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
  paintSized,
  toneColor,
  wrapLines,
} from "./poster";

export type PickPosterRow = {
  name: string;
  code: string;
  chg: number | null;
  price: number;
  buy: number;
  sell: number;
  badge: string;
};

export function drawPicksPoster(input: { date: string; styleName: string; openCount: number; rows: PickPosterRow[] }) {
  const { canvas, ctx } = openPoster();
  paintMark(ctx, dayFromDate(input.date));
  paintTitle(ctx, input.styleName, "打到买入价才记。红涨绿跌。");
  const waiting = input.rows.filter((row) => row.badge === "等待买入").length;
  let y = paintCards(ctx, 212, [
    { label: "精选", value: String(input.rows.length), color: INK, note: input.styleName },
    { label: "这套持仓", value: String(input.openCount), color: INK, note: "打到买入价才算" },
    { label: "等待买入", value: String(waiting), color: waiting ? RED : INK, note: "还没到价" },
  ]);
  y += 28;
  y = paintSection(ctx, y, "精选", RED);
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "left";
  ctx.fillText("名称", 56, y + 16);
  ctx.textAlign = "right";
  ctx.fillText("现价", 520, y + 16);
  ctx.fillText("涨跌", 680, y + 16);
  ctx.fillText("买入", 860, y + 16);
  ctx.fillText("状态", POSTER_W - 56, y + 16);
  y += 40;
  const rows = input.rows.slice(0, 10);
  if (rows.length === 0) {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText("这套策略现在没有符合的股票。", 56, y + 20);
    y += 52;
  }
  for (const row of rows) {
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(POSTER_W - 56, y);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    paintSized(ctx, `${row.name} ${row.code}`, 56, y + 26, 360, 24, 16);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    paintSized(ctx, fmtPrice(row.price), 560, y + 26, 90, 24, 16);
    ctx.fillStyle = toneColor(row.chg);
    paintSized(ctx, signedPct(row.chg), 700, y + 26, 110, 24, 16);
    ctx.fillStyle = INK;
    paintSized(ctx, fmtPrice(row.buy), 860, y + 26, 90, 24, 16);
    ctx.fillStyle = MUTED;
    paintSized(ctx, row.badge, POSTER_W - 56, y + 26, 140, 22, 14);
    y += 52;
  }
  y = paintFoot(ctx, y + 20, `卖出价写在账上，图里只列买入价。共 ${input.rows.length} 只。`);
  return { canvas: cropPoster(canvas, y), filename: `赤轨-选股-${fileDate(input.date)}.png` };
}

export function drawNewsPoster(input: {
  date: string;
  goodBoards: { name: string; n: number }[];
  badBoards: { name: string; n: number }[];
  goodStocks: { name: string; chg: number | null }[];
  badStocks: { name: string; chg: number | null }[];
  total: number;
}) {
  const { canvas, ctx } = openPoster();
  paintMark(ctx, dayFromDate(input.date));
  paintTitle(ctx, "消息汇总", "按标题用词。不是研报，不改买入价。");
  let y = paintCards(ctx, 212, [
    { label: "利好", value: String(input.goodStocks.length), color: RED, note: "点到名的个股" },
    { label: "利空", value: String(input.badStocks.length), color: GREEN, note: "点到名的个股" },
    { label: "快讯", value: String(input.total), color: INK, note: "这批条数" },
  ]);
  y += 28;
  y = twoCols(ctx, y, "利好个股", input.goodStocks.map((row) => ({ name: row.name, value: signedPct(row.chg), color: toneColor(row.chg) })), "利空个股", input.badStocks.map((row) => ({ name: row.name, value: signedPct(row.chg), color: toneColor(row.chg) })));
  y += 16;
  y = twoCols(
    ctx,
    y,
    "利好板块",
    input.goodBoards.map((row) => ({ name: row.name, value: `${row.n} 条`, color: RED })),
    "利空板块",
    input.badBoards.map((row) => ({ name: row.name, value: `${row.n} 条`, color: GREEN })),
  );
  y = paintFoot(ctx, y + 12, "利好在左，利空在右。每边最多六条。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-消息-${fileDate(input.date)}.png` };
}

export function drawSymbolPoster(input: {
  date: string;
  title: string;
  chg: number | null;
  good: number;
  bad: number;
  ann: number;
  lines: { label: string; text: string; tone: NewsTone }[];
}) {
  const { canvas, ctx } = openPoster();
  paintMark(ctx, dayFromDate(input.date));
  paintTitle(ctx, fit(ctx, input.title, 900), "资讯和公告。红是利好，绿是利空。");
  let y = paintCards(ctx, 212, [
    { label: "今日", value: signedPct(input.chg), color: toneColor(input.chg), note: "现价涨跌" },
    { label: "利好", value: String(input.good), color: input.good ? RED : INK, note: "标题用词" },
    { label: "利空", value: String(input.bad), color: input.bad ? GREEN : INK, note: `公告 ${input.ann} 条` },
  ]);
  y += 28;
  y = paintSection(ctx, y, "最近", input.bad > 0 ? GREEN : RED);
  const lines = input.lines.slice(0, 8);
  if (lines.length === 0) {
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText("暂时没有消息。", 56, y + 20);
    y += 52;
  }
  for (const line of lines) {
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(POSTER_W - 56, y);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = line.tone === "good" ? RED : line.tone === "bad" ? GREEN : MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(line.label, 56, y + 26);
    ctx.font = `24px ${FONT}`;
    const textLines = wrapLines(ctx, line.text, POSTER_W - 230);
    const h = Math.max(52, textLines.length * 32 + 16);
    ctx.fillStyle = INK;
    textLines.forEach((text, index) => ctx.fillText(text, 168, y + 26 + index * 32));
    y += h;
  }
  y = paintFoot(ctx, y + 16, "用词判断不是研报。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-个股-${fileDate(input.date)}.png` };
}

export function articleLine(item: StockArticle): { label: string; text: string; tone: NewsTone } {
  const kind = item.kind === "ann" ? "公告" : "资讯";
  const tone = item.tone === "good" ? "利好" : item.tone === "bad" ? "利空" : "未表态";
  return { label: `${kind} ${tone}`, text: item.title, tone: item.tone };
}

function twoCols(
  ctx: CanvasRenderingContext2D,
  y: number,
  left: string,
  leftRows: { name: string; value: string; color: string }[],
  right: string,
  rightRows: { name: string; value: string; color: string }[],
): number {
  const colW = (POSTER_W - 112 - 24) / 2;
  const rightX = 56 + colW + 24;
  paintSection(ctx, y, left, RED, 56);
  y = paintSection(ctx, y, right, GREEN, rightX);
  for (let index = 0; index < 6; index += 1) {
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(56 + colW, y);
    ctx.moveTo(rightX, y);
    ctx.lineTo(POSTER_W - 56, y);
    ctx.stroke();
    cell(ctx, 56, y, colW, index, leftRows[index]);
    cell(ctx, rightX, y, colW, index, rightRows[index]);
    y += 52;
  }
  return y;
}

function cell(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, index: number, row?: { name: string; value: string; color: string }) {
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillStyle = "#5d6b7c";
  ctx.fillText(String(index + 1).padStart(2, "0"), x, y + 26);
  if (!row) {
    ctx.fillText("—", x + 44, y + 26);
    return;
  }
  ctx.font = `24px ${FONT}`;
  ctx.fillStyle = INK;
  paintSized(ctx, row.name, x + 44, y + 26, width * 0.5, 24, 16);
  ctx.textAlign = "right";
  ctx.fillStyle = row.color;
  paintSized(ctx, row.value, x + width, y + 26, width * 0.42, 22, 14);
}
