import { fmtPrice, signedPct } from "./format";
import type { NewsTone, StockArticle } from "./news";
import {
  FONT,
  GREEN,
  INK,
  MUTED,
  RED,
  beginPoster,
  cropPoster,
  dayFromDate,
  edge,
  fileDate,
  fit,
  openPoster,
  paintCards,
  paintFoot,
  paintHairline,
  paintHead,
  paintSection,
  paintSized,
  rightEdge,
  themeName,
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
  beginPoster();
  const { canvas, ctx } = openPoster();
  const left = edge();
  const right = rightEdge();
  const waiting = input.rows.filter((row) => row.badge === "等待买入").length;
  let y = paintHead(ctx, dayFromDate(input.date), input.styleName, "打到买入价才记。红涨绿跌。");
  y = paintCards(ctx, y + 16, [
    { label: "精选", value: String(input.rows.length), color: INK, note: input.styleName },
    { label: "这套持仓", value: String(input.openCount), color: INK, note: "打到买入价才算" },
    { label: "等待买入", value: String(waiting), color: waiting ? RED : INK, note: "还没到价" },
  ]);
  y += 24;
  y = paintSection(ctx, y, "精选", RED);
  const span = right - left;
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "left";
  ctx.fillText("名称", left, y + 16);
  ctx.textAlign = "right";
  ctx.fillText("现价", left + span * 0.55, y + 16);
  ctx.fillText("涨跌", left + span * 0.7, y + 16);
  ctx.fillText("买入", left + span * 0.84, y + 16);
  ctx.fillText("状态", right, y + 16);
  y += 40;
  const rows = input.rows.slice(0, 10);
  if (rows.length === 0) {
    ctx.textAlign = "left";
    ctx.fillStyle = MUTED;
    ctx.font = `24px ${FONT}`;
    ctx.fillText("这套策略现在没有符合的股票。", left, y + 20);
    y += 52;
  }
  for (const row of rows) {
    paintHairline(ctx, y, left, right);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    paintSized(ctx, `${row.name} ${row.code}`, left, y + 26, span * 0.4, 24, 16);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    paintSized(ctx, fmtPrice(row.price), left + span * 0.55, y + 26, span * 0.12, 24, 16);
    ctx.fillStyle = toneColor(row.chg);
    paintSized(ctx, signedPct(row.chg), left + span * 0.7, y + 26, span * 0.12, 24, 16);
    ctx.fillStyle = INK;
    paintSized(ctx, fmtPrice(row.buy), left + span * 0.84, y + 26, span * 0.12, 24, 16);
    ctx.fillStyle = MUTED;
    paintSized(ctx, row.badge, right, y + 26, span * 0.14, 22, 14);
    y += 52;
  }
  y = paintFoot(ctx, y + 20, `卖出价写在账上，图里只列买入价。共 ${input.rows.length} 只。`);
  return { canvas: cropPoster(canvas, y), filename: `赤轨-选股-${themeName()}-${fileDate(input.date)}.png` };
}

export function drawNewsPoster(input: {
  date: string;
  goodBoards: { name: string; n: number }[];
  badBoards: { name: string; n: number }[];
  goodStocks: { name: string; chg: number | null }[];
  badStocks: { name: string; chg: number | null }[];
  total: number;
}) {
  beginPoster();
  const { canvas, ctx } = openPoster();
  let y = paintHead(ctx, dayFromDate(input.date), "消息汇总", "按标题用词。不是研报，不改买入价。");
  y = paintCards(ctx, y + 16, [
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
  return { canvas: cropPoster(canvas, y), filename: `赤轨-消息-${themeName()}-${fileDate(input.date)}.png` };
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
  beginPoster();
  const { canvas, ctx } = openPoster();
  let y = paintHead(ctx, dayFromDate(input.date), fit(ctx, input.title, rightEdge() - edge()), "资讯和公告。红是利好，绿是利空。");
  y = paintCards(ctx, y + 16, [
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
    ctx.fillText("暂时没有消息。", edge(), y + 20);
    y += 52;
  }
  for (const line of lines) {
    paintHairline(ctx, y, edge(), rightEdge());
    ctx.textAlign = "left";
    ctx.fillStyle = line.tone === "good" ? RED : line.tone === "bad" ? GREEN : MUTED;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(line.label, edge(), y + 26);
    ctx.font = `24px ${FONT}`;
    const textLines = wrapLines(ctx, line.text, rightEdge() - edge() - 150);
    const h = Math.max(52, textLines.length * 32 + 16);
    ctx.fillStyle = INK;
    textLines.forEach((text, index) => ctx.fillText(text, edge() + 120, y + 26 + index * 32));
    y += h;
  }
  y = paintFoot(ctx, y + 16, "用词判断不是研报。");
  return { canvas: cropPoster(canvas, y), filename: `赤轨-个股-${themeName()}-${fileDate(input.date)}.png` };
}

export function articleLine(item: StockArticle): { label: string; text: string; tone: NewsTone } {
  const kind = item.kind === "ann" ? "公告" : "资讯";
  const tone = item.tone === "good" ? "利好" : item.tone === "bad" ? "利空" : "未表态";
  return { label: `${kind} ${tone}`, text: item.title, tone: item.tone };
}

function twoCols(
  ctx: CanvasRenderingContext2D,
  y: number,
  leftTitle: string,
  leftRows: { name: string; value: string; color: string }[],
  rightTitle: string,
  rightRows: { name: string; value: string; color: string }[],
): number {
  const left = edge();
  const right = rightEdge();
  const colW = (right - left - 24) / 2;
  const rightX = left + colW + 24;
  paintSection(ctx, y, leftTitle, RED, left);
  y = paintSection(ctx, y, rightTitle, GREEN, rightX);
  for (let index = 0; index < 6; index += 1) {
    paintHairline(ctx, y, left, left + colW);
    paintHairline(ctx, y, rightX, right);
    cell(ctx, left, y, colW, index, leftRows[index]);
    cell(ctx, rightX, y, colW, index, rightRows[index]);
    y += 52;
  }
  return y;
}

function cell(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, index: number, row?: { name: string; value: string; color: string }) {
  ctx.font = `22px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillStyle = MUTED;
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
