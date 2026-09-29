// 交易时段里，现价打到这只股票的买入价才记入。买入价写下后不再改。
// 之后碰到卖出价或止损价就结算；同一天两边都碰到按止损。否则等第 8 个交易日收盘。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exitFill, nthClose } from "../src/lib/market/journal-book.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { planExit } from "../src/lib/market/model.ts";
import { STYLE_IDS, styleOf, takeBuys, watchList } from "../src/lib/market/strategies.ts";
import { formatClock, isTradingDay, sessionPhase } from "../src/lib/market/session.ts";

type Trade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: "early" | "trend" | "breakout" | "value";
  exit: number | null;
  exitDate: string | null;
};

type Day = {
  date: string;
  savedAt: number;
  signalTime: string;
  status?: "provisional" | "locked";
  ruleVersion?: number;
  indexEntry: number | null;
  indexExit: number | null;
  trades: Trade[];
};

type Book = { days: Day[]; nextSettleAt?: number };

const bookPath = join(process.cwd(), "data", "journal.json");

async function readBook(): Promise<Book> {
  try {
    const parsed = JSON.parse(await readFile(bookPath, "utf8")) as Book;
    return { days: Array.isArray(parsed.days) ? parsed.days : [], nextSettleAt: parsed.nextSettleAt };
  } catch {
    return { days: [] };
  }
}

async function writeBook(book: Book) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(bookPath, JSON.stringify(book, null, 2));
}

const rules = await readRules();
const prefs = await readPrefs();
const phase = sessionPhase();
const time = formatClock(Date.now());
const book = await readBook();
let days = book.days;
let changed = false;
const tagged = days.map((day) => ({ ...day, trades: day.trades.filter((trade) => styleOf(trade) != null) }));
if (tagged.some((day, index) => day.trades.length !== days[index].trades.length)) changed = true;
days = tagged.filter((day) => day.trades.length > 0);

if (phase.date && isTradingDay(phase.date) && (phase.open || phase.sealed)) {
  const universe = await loadUniverse(true);
  const indices = await loadIndices();
  const index = indices.find((item) => item.id === "sh000300");
  const live = universe.quotes.some((quote) => quote.amount > 0 && quote.turnover > 0);
  if (live) {
    const held = days.flatMap((day) => day.trades);
    const existing = days.find((day) => day.date === phase.date);
    const additions: Trade[] = [];
    for (const style of STYLE_IDS) {
      const list = watchList(universe.quotes, style, rules, (quote) => matchPrefs(quote, prefs));
      for (const row of takeBuys(list, held, style)) {
        additions.push({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          exit: null,
          exitDate: null,
        });
        held.push({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          exit: null,
          exitDate: null,
        });
      }
    }
    if (additions.length > 0) {
      const next: Day = existing
        ? { ...existing, trades: [...existing.trades, ...additions] }
        : {
            date: phase.date,
            savedAt: Date.now(),
            signalTime: time,
            status: phase.sealed ? "locked" : "provisional",
            ruleVersion: rules.version,
            indexEntry: index && index.price > 0 ? index.price : null,
            indexExit: null,
            trades: additions,
          };
      days = existing ? days.map((day) => (day.date === phase.date ? next : day)) : [next, ...days].slice(0, 80);
      changed = true;
      console.log(`bought ${phase.date} ${additions.length}`);
    } else {
      console.log(`${time} no buy`);
    }
  }
}

const pending = days.some(
  (day) => day.trades.some((trade) => trade.exit == null) || (day.indexEntry != null && day.indexExit == null),
);
const settleDue = pending && (book.nextSettleAt == null || Date.now() >= book.nextSettleAt);
if (settleDue && phase.date) {
  let stillOpen = false;
  for (const day of days) {
    for (const trade of day.trades) {
      if (trade.exit != null) continue;
      try {
        const data = await loadKline(trade.id);
        const plan = trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
        const filled = exitFill(data.bars, day.date, trade.entry, plan.stop, plan.target);
        if (!filled) {
          stillOpen = true;
          continue;
        }
        trade.exit = filled.price;
        trade.exitDate = filled.date;
        changed = true;
      } catch {
        stillOpen = true;
      }
    }
    if (day.indexExit == null && day.indexEntry != null) {
      try {
        const data = await loadKline("sh000300");
        const next = nthClose(data.bars, day.date);
        if (next) {
          day.indexExit = next.price;
          changed = true;
        } else stillOpen = true;
      } catch {
        stillOpen = true;
      }
    }
  }
  book.nextSettleAt = Date.now() + (stillOpen ? 30 * 60_000 : 12 * 60 * 60_000);
  changed = true;
}

if (changed) await writeBook({ days, nextSettleAt: book.nextSettleAt });
else console.log(`${time} ${phase.label} no change`);
