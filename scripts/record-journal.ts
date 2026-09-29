// 本机服务每分钟跑一次。14:40–15:00 只记临时名单，15:00 才锁定。
// 目标价碰到就结算；否则等第 8 个交易日收盘。买入价写入后不再改。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayLocked, exitFill, nthClose } from "../src/lib/market/journal-book.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { screen } from "../src/lib/market/model.ts";
import { formatClock, isTradingDay, sessionPhase } from "../src/lib/market/session.ts";

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
const closeWindow = time >= "14:40" && time < "15:00";
const book = await readBook();
let days = book.days;
let changed = false;

if (phase.date && isTradingDay(phase.date) && (phase.sealed || closeWindow)) {
  const existing = days.find((day) => day.date === phase.date);
  if (!existing || !dayLocked(existing)) {
    const universe = await loadUniverse(true);
    const indices = await loadIndices();
    const index = indices.find((item) => item.id === "sh000300");
    const live = universe.quotes.some((quote) => quote.amount > 0 && quote.turnover > 0);
    const same = existing != null && (existing.ruleVersion ?? 1) === rules.version;
    const trades: Trade[] = [];
    if (live) {
      for (const quote of universe.quotes) {
        if (!screen(quote, true, rules) || !matchPrefs(quote, prefs) || !(quote.price > 0)) continue;
        const prior = same ? existing?.trades.find((trade) => trade.id === quote.id) : undefined;
        trades.push({
          id: quote.id,
          code: quote.code,
          name: quote.name,
          entry: prior && prior.entry > 0 ? prior.entry : quote.price,
          exit: null,
          exitDate: null,
        });
      }
    }
    if (phase.sealed || trades.length > 0) {
      const next: Day = {
        date: phase.date,
        savedAt: Date.now(),
        signalTime: same && existing?.signalTime && existing.signalTime >= "14:40" ? existing.signalTime : phase.sealed ? "15:00" : time,
        status: phase.sealed ? "locked" : "provisional",
        ruleVersion: rules.version,
        indexEntry: (same ? existing?.indexEntry : null) ?? (index && index.price > 0 ? index.price : null),
        indexExit: null,
        trades,
      };
      days = existing ? days.map((day) => (day.date === phase.date ? next : day)) : [next, ...days].slice(0, 80);
      changed = true;
      console.log(`locked ${phase.date} ${trades.length}`);
    } else {
      console.log(`${time} tail empty, not locked`);
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
        const filled = exitFill(data.bars, day.date, trade.entry);
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
