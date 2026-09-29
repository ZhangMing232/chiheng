// 交易时段里，现价打到这只股票的买入价才记入。买入价写下后不再改。
// 之后碰到卖出价或止损价就结算；同一天两边都碰到按止损。否则等第 8 个交易日收盘。
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { exitFill, nthClose } from "../src/lib/market/journal-book.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { boardLimit, limitTag, planExit } from "../src/lib/market/model.ts";
import { STYLE_IDS, STYLES, styleOf, takeBuys, watchList } from "../src/lib/market/strategies.ts";
import { loadRelay } from "../src/lib/market/sectors.ts";
import { formatClock, isTradingDay, sessionPhase } from "../src/lib/market/session.ts";

type Trade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: "early" | "trend" | "breakout" | "value" | "relay";
  hold?: number;
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
const pulsePath = join(process.cwd(), "data", "recorder.json");
const alertPath = join(process.cwd(), "data", "sell-alerts.json");
const backupDir = join(homedir(), "chiheng-backup");

function notify(body: string) {
  if (process.platform !== "darwin") return;
  execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify("候价")}`], () => undefined);
}

function notifyNames(label: string, names: string[]) {
  if (names.length === 0) return;
  const shown = names.slice(0, 3);
  const more = names.length > shown.length ? `等 ${names.length} 只` : "";
  notify(`${shown.join("、")}${more} ${label}`);
}

async function readAlerts(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(alertPath, "utf8")) as { sells?: unknown };
    return new Set(Array.isArray(parsed.sells) ? parsed.sells.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

async function writeAlerts(sells: Set<string>) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(alertPath, JSON.stringify({ sells: [...sells] }));
}

async function mark(ok: boolean) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(pulsePath, JSON.stringify({ at: Date.now(), ok }));
}

async function backup(date: string) {
  try {
    await access(bookPath);
  } catch {
    return;
  }
  await mkdir(backupDir, { recursive: true });
  await copyFile(bookPath, join(backupDir, `journal-${date}.json`));
}

let failing = false;
process.on("unhandledRejection", (err) => {
  console.error(err);
  if (failing) process.exit(1);
  failing = true;
  void mark(false).finally(() => process.exit(1));
});

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
const alerts = await readAlerts();
let alertsChanged = false;
let days = book.days;
let changed = false;
const tagged = days.map((day) => ({ ...day, trades: day.trades.filter((trade) => styleOf(trade) != null) }));
if (tagged.some((day, index) => day.trades.length !== days[index].trades.length)) changed = true;
days = tagged.filter((day) => day.trades.length > 0);

if (phase.date && isTradingDay(phase.date) && phase.matching) {
  const universe = await loadUniverse(true);
  const indices = await loadIndices();
  const index = indices.find((item) => item.id === "sh000300");
  const live = universe.quotes.some((quote) => quote.amount > 0 && quote.turnover > 0);
  if (live) {
    const held = days.flatMap((day) => day.trades);
    const existing = days.find((day) => day.date === phase.date);
    const additions: Trade[] = [];
    let relay: Awaited<ReturnType<typeof loadRelay>> = [];
    try {
      relay = await loadRelay(phase.tailHalf, phase.date);
    } catch {
      relay = [];
    }
    for (const style of STYLE_IDS) {
      const list =
        style === "relay"
          ? relay.filter((row) => matchPrefs(row.quote, prefs))
          : watchList(universe.quotes, style, rules, (quote) => matchPrefs(quote, prefs));
      for (const row of takeBuys(list, held, style)) {
        additions.push({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          hold: style === "relay" ? 1 : undefined,
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
          hold: style === "relay" ? 1 : undefined,
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
      const shown = additions.slice(0, 3).map((trade) => {
        const style = STYLES.find((item) => item.id === trade.style)?.name ?? "";
        return `${style} ${trade.name}`.trim();
      });
      const more = additions.length > shown.length ? `等 ${additions.length} 只` : "";
      notify(`${shown.join("、")}${more} 已到买入价`);
      console.log(`bought ${phase.date} ${additions.length}`);
    } else {
      console.log(`${time} no buy`);
    }
    const stops: string[] = [];
    const targets: string[] = [];
    for (const day of days) {
      if (day.date >= phase.date) continue;
      for (const trade of day.trades) {
        if (trade.exit != null) continue;
        const quote = universe.quotes.find((item) => item.id === trade.id);
        if (!quote || limitTag(quote) === "跌停") continue;
        const plan = trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
        const style = STYLES.find((item) => item.id === trade.style)?.name ?? "";
        const label = `${style} ${trade.name}`.trim();
        const hit = quote.price <= plan.stop ? "stop" : quote.price >= plan.target ? "target" : null;
        if (!hit) continue;
        const key = `${day.date}:${trade.id}:${hit}`;
        if (!alerts.has(key)) {
          alerts.add(key);
          alertsChanged = true;
          (hit === "stop" ? stops : targets).push(label);
        }
        trade.exit = hit === "stop" ? plan.stop : plan.target;
        trade.exitDate = phase.date;
        changed = true;
      }
    }
    notifyNames("到止损价", stops);
    notifyNames("到卖出价", targets);
  }
}

const pending = days.some(
  (day) => day.trades.some((trade) => trade.exit == null) || (day.indexEntry != null && day.indexExit == null),
);
const settleDue = pending && (book.nextSettleAt == null || Date.now() >= book.nextSettleAt);
if (settleDue && phase.date) {
  let stillOpen = false;
  const due: string[] = [];
  for (const day of days) {
    for (const trade of day.trades) {
      if (trade.exit != null) continue;
      try {
        const data = await loadKline(trade.id);
        const plan = trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
        const filled = exitFill(
          data.bars,
          day.date,
          trade.entry,
          plan.stop,
          plan.target,
          boardLimit(trade.id, trade.name),
          trade.hold ?? 8,
        );
        if (!filled) {
          stillOpen = true;
          continue;
        }
        trade.exit = filled.price;
        trade.exitDate = filled.date;
        changed = true;
        const key = `${day.date}:${trade.id}:${filled.reason}`;
        if (filled.reason === "time" && !alerts.has(key)) {
          alerts.add(key);
          alertsChanged = true;
          const style = STYLES.find((item) => item.id === trade.style)?.name ?? "";
          due.push(`${style} ${trade.name}`.trim());
        }
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
  notifyNames("到期该卖", due);
}

if (changed) await writeBook({ days, nextSettleAt: book.nextSettleAt });
else console.log(`${time} ${phase.label} no change`);
if (alertsChanged) await writeAlerts(alerts);

await mark(true);
const backupDate = phase.date || new Date().toISOString().slice(0, 10);
const backupPath = join(backupDir, `journal-${backupDate}.json`);
let backed = false;
try {
  await access(backupPath);
  backed = true;
} catch {
  backed = false;
}
if (changed || (phase.sealed && !backed)) await backup(backupDate);
