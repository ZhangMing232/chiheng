import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { evaluate } from "../src/lib/market/model.ts";
import { formatClock, sessionPhase } from "../src/lib/market/session.ts";

type Trade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  exit: number | null;
  exitDate: string | null;
};

type Day = {
  date: string;
  savedAt: number;
  signalTime: string;
  indexEntry: number | null;
  indexExit: number | null;
  trades: Trade[];
};

const bookPath = join(process.cwd(), "data", "journal.json");
const CHECK_DAYS = 8;

function normDate(value: string): string {
  const match = value.match(/(\d{4})-?(\d{2})-?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function barAfter(bars: { date: string; c: number }[], date: string, sessions: number) {
  const index = bars.findIndex((bar) => normDate(bar.date) === date);
  if (index < 0) return null;
  let left = sessions;
  for (let cursor = index + 1; cursor < bars.length; cursor += 1) {
    left -= 1;
    if (left === 0) return bars[cursor];
  }
  return null;
}

async function readBook(): Promise<Day[]> {
  try {
    const parsed = JSON.parse(await readFile(bookPath, "utf8")) as { days?: Day[] };
    return Array.isArray(parsed.days) ? parsed.days : [];
  } catch {
    return [];
  }
}

async function writeBook(days: Day[]) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(bookPath, JSON.stringify({ days }, null, 2));
}

const phase = sessionPhase();
const time = formatClock(Date.now());
const openWindow = time >= "09:25" && time <= "09:30";
const closeWindow = time >= "14:40" && time < "15:00";
let days = await readBook();
let changed = false;

if (!phase.date) {
  console.log("no session date");
} else if (phase.sealed || openWindow || closeWindow) {
  const existing = days.find((day) => day.date === phase.date);
  if (!existing) {
    const universe = await loadUniverse(true);
    const indices = await loadIndices();
    const index = indices.find((item) => item.id === "sh000300");
    const live = universe.quotes.some((quote) => quote.amount > 0 && quote.turnover > 0);
    const strict = phase.sealed || closeWindow;
    const trades: Trade[] = [];
    if (live) {
      for (const quote of universe.quotes) {
        if (!evaluate("early", quote, true, strict) || !(quote.price > 0)) continue;
        trades.push({
          id: quote.id,
          code: quote.code,
          name: quote.name,
          entry: quote.price,
          exit: null,
          exitDate: null,
        });
      }
    }
    if (phase.sealed || trades.length > 0) {
      days = [
        {
          date: phase.date,
          savedAt: Date.now(),
          signalTime: phase.sealed ? "15:00" : time,
          indexEntry: index && index.price > 0 ? index.price : null,
          indexExit: null,
          trades,
        },
        ...days,
      ].slice(0, 80);
      changed = true;
      console.log(`recorded ${phase.date} ${trades.length}`);
    } else {
      console.log(`${time} window empty, not locked`);
    }
  }
}

const settleWindow = phase.sealed && time >= "15:10" && time <= "15:40";
if (settleWindow) {
  for (const day of days) {
    for (const trade of day.trades) {
      if (trade.exit != null) continue;
      try {
        const data = await loadKline(trade.id);
        const next = barAfter(data.bars, day.date, CHECK_DAYS);
        if (!next || !(next.c > 0)) continue;
        const entryBar = data.bars.find((bar) => normDate(bar.date) === day.date);
        trade.exit = next.c;
        trade.exitDate = normDate(next.date);
        if (entryBar && entryBar.c > 0) trade.entry = entryBar.c;
        changed = true;
      } catch {
        // 日线还没到结算日。
      }
    }
    if (day.indexExit == null && day.indexEntry != null) {
      try {
        const data = await loadKline("sh000300");
        const next = barAfter(data.bars, day.date, CHECK_DAYS);
        if (next && next.c > 0) {
          day.indexExit = next.c;
          changed = true;
        }
      } catch {
        // 沪深 300 日线暂时没有。
      }
    }
  }
}

if (changed) await writeBook(days);
else console.log(`${time} ${phase.label} no change`);
