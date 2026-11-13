/**
 * P2 对账评估：近 N 个交易日「/today 说了什么」vs「后来真买了什么」。
 *
 * 纯只读，不写任何文件、不改账本、不改 reviewed.json。用来回答
 * design/PLAN-unify-daily-picks.md §4 的前置问题：两份名单到底差在哪、差得有没有道理。
 *
 * 口径与页面一致：三分类直接调 src/lib/market/daily-reconcile.ts 的 reconcileDay，
 * 不在这里另写一套匹配逻辑（避免「分析口径」和「页面口径」自己先对不上）。
 *
 * 数据来源（都是只读）：
 *   - 当天 /today 名单：data/signals/reviewed.json
 *   - 历史 /today 名单：CHIHENG_BACKUP_DIR 下各 full- 快照目录里的 signals/reviewed.json
 *   - 账本真实成交：data/books/<OWNER_ID>.json
 *   - 记账链候选留痕：data/.signals-<date>.json、data/signals.jsonl
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/reconcile-p2.ts
 *   CHIHENG_BACKUP_DIR=/path/to/chiheng-backup OWNER_ID=dev-user node ...
 *
 * ⚠️ 账本 days[] 不按日期排序（实测末项是 09-29，11-13 插在中间）。
 *    一律按 date 字段匹配，绝不写 days[days.length - 1] 取「最新一天」。
 */

import { readFileSync, existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { reconcileDay, reconcileSummary, sixDigitCode } from "../src/lib/market/daily-reconcile.ts";
import { ACTIVE_STYLES, RETIRED_STYLES } from "../src/lib/market/strategies.ts";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const BACKUP = process.env.CHIHENG_BACKUP_DIR ?? join(homedir(), "chiheng-backup");
const OWNER = process.env.OWNER_ID ?? "dev-user";

type Reviewed = {
  date: string;
  ok?: number;
  warn?: number;
  skip?: number;
  signals: {
    code: string;
    name: string;
    strategy?: string;
    leg?: "long" | "short";
    verdict?: "ok" | "warn" | "skip";
    order?: { price?: number };
    fill?: { status?: "filled" | "missed" | "pending" };
  }[];
};
type Trade = {
  code: string;
  name: string;
  entry: number;
  style?: string;
  variant?: string | null;
  deepScan?: boolean | null;
  exit?: number | null;
};
type BookDay = { date: string; trades: Trade[] };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 收集 /today 名单：当天 + 备份快照（同一天以当天文件为准）。 */
function loadReviewed(): Map<string, Reviewed> {
  const out = new Map<string, Reviewed>();
  const snapshots = globSync(join(BACKUP, "full-*", "signals", "reviewed.json")).sort();
  for (const p of snapshots) {
    const d = readJson<Reviewed>(p);
    if (d?.date) out.set(d.date, d);
  }
  const today = readJson<Reviewed>(join(DATA, "signals", "reviewed.json"));
  if (today?.date) out.set(today.date, today);
  return out;
}

const book = readJson<{ days: BookDay[] }>(join(DATA, "books", `${OWNER}.json`));
if (!book) {
  console.error(`账本读不到：${join(DATA, "books", `${OWNER}.json`)}`);
  process.exit(1);
}
const reviewed = loadReviewed();
if (reviewed.size === 0) {
  console.error("一份 /today 名单都读不到（当天文件与备份快照都没有）。不编数字，直接退出。");
  process.exit(1);
}

/** 记账链候选留痕：.signals-<date>.json 是当天第一次扫描的名单。 */
function chainCodes(date: string): Set<string> {
  const p = join(DATA, `.signals-${date}.json`);
  const d = readJson<Record<string, string[]>>(p);
  if (!d) return new Set();
  return new Set(Object.values(d).flat().map(sixDigitCode));
}
/** signals.jsonl：记账进程每 ~4 分钟扫一次留的候选（含没成交的）。 */
function loggedCodes(date: string): Set<string> {
  const p = join(DATA, "signals.jsonl");
  if (!existsSync(p)) return new Set();
  const out = new Set<string>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { tradingDate?: string; code?: string };
      if (row.tradingDate === date && row.code) out.add(sixDigitCode(row.code));
    } catch {
      /* 坏行跳过，不编数据 */
    }
  }
  return out;
}

/** 「账本买了 /today 没提」的逐笔归因。分类是互斥的，顺序即优先级。 */
function attribute(trade: Trade, inLog: boolean): string {
  if (trade.variant || trade.deepScan) return "挑战者/深扫实验";
  if (trade.style && trade.style !== "value") return "非现役策略结算";
  if (inLog) return "盘中新增扫描(09:26名单外)";
  return "其他/未留痕";
}

const dates = [...reviewed.keys()].sort();
const totals = {
  signals: 0,
  book: 0,
  matched: 0,
  signalOnly: 0,
  bookOnly: 0,
  attribution: new Map<string, number>(),
  byStrategy: new Map<string, { total: number; hit: number }>(),
  shortLegHit: 0,
  shortLegTotal: 0,
};

console.log(`P2 对账评估 · ${dates.length} 个交易日 · 账本 ${OWNER} · 备份 ${BACKUP}`);
console.log("═".repeat(112));
console.log("日期        /today  账本  重合  /today有没买  账本独有   chain候选∩账本   /today∩chain");
console.log("─".repeat(112));

for (const date of dates) {
  const r = reviewed.get(date)!;
  const res = reconcileDay({
    date,
    signals: r.signals.map((s) => ({
      code: s.code,
      name: s.name,
      leg: s.leg,
      orderPrice: s.order?.price ?? null,
      fillStatus: s.fill?.status,
      verdict: s.verdict,
    })),
    days: book.days.map((d) => ({
      date: d.date,
      trades: d.trades.map((t) => ({
        code: t.code, name: t.name, entry: t.entry, style: t.style, exit: t.exit,
      })),
    })),
  });

  const chain = chainCodes(date);
  const log = loggedCodes(date);
  const bookCodes = new Set(res.bookTrades.map((t) => sixDigitCode(t.code)));
  const todayCodes = new Set(r.signals.map((s) => sixDigitCode(s.code)));

  totals.signals += res.signalRows.length;
  totals.book += res.bookTradeCount;
  totals.matched += res.matched.length;
  totals.signalOnly += res.signalOnly.length;
  totals.bookOnly += res.bookOnly.length;

  for (const t of res.bookOnly) {
    const full = book.days.find((d) => d.date === date)?.trades.find((x) => sixDigitCode(x.code) === sixDigitCode(t.code));
    const cat = attribute(full ?? { code: t.code, name: t.name, entry: t.entry, style: t.style }, log.has(sixDigitCode(t.code)));
    totals.attribution.set(cat, (totals.attribution.get(cat) ?? 0) + 1);
  }
  for (const s of r.signals) {
    const key = s.strategy ?? "未标策略";
    const agg = totals.byStrategy.get(key) ?? { total: 0, hit: 0 };
    agg.total += 1;
    if (bookCodes.has(sixDigitCode(s.code))) agg.hit += 1;
    totals.byStrategy.set(key, agg);
    if (s.leg === "short") {
      totals.shortLegTotal += 1;
      if (bookCodes.has(sixDigitCode(s.code))) totals.shortLegHit += 1;
    }
  }

  const chainHit = [...bookCodes].filter((c) => chain.has(c)).length;
  console.log(
    `${date}  ${String(res.signalRows.length).padStart(5)}  ${String(res.bookTradeCount).padStart(5)}  ` +
    `${String(res.matched.length).padStart(4)}  ${String(res.signalOnly.length).padStart(12)}  ` +
    `${String(res.bookOnly.length).padStart(9)}  ${String(`${chainHit}/${res.bookTradeCount}`).padStart(14)}  ` +
    `${String(`${[...todayCodes].filter((c) => chain.has(c)).length}/${todayCodes.size}`).padStart(14)}`,
  );
  if (res.missing) console.log(`         ⚠ ${res.missing}`);
  console.log(`         ${reconcileSummary(res)} · 账本独有 ${res.bookOnly.map((t) => sixDigitCode(t.code)).join(",") || "无"}`);
}

console.log("═".repeat(112));
console.log(`合计：/today ${totals.signals} 只次 · 账本 ${totals.book} 笔 · 重合 ${totals.matched} 只 ` +
  `(${(totals.matched / totals.signals * 100).toFixed(1)}% 按信号只次) · /today有没买 ${totals.signalOnly} · 账本独有 ${totals.bookOnly}`);

console.log("\n【账本独有逐笔归因】");
for (const [cat, n] of [...totals.attribution].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(30)} ${String(n).padStart(3)} 笔  (${(n / totals.bookOnly * 100).toFixed(0)}%)`);
}

console.log("\n【/today 各策略腿 → 账本命中】");
for (const [name, v] of [...totals.byStrategy].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${name.padEnd(20)} ${String(v.hit).padStart(3)}/${String(v.total).padEnd(3)} 命中`);
}
console.log(`  short 腿合计           ${String(totals.shortLegHit).padStart(3)}/${String(totals.shortLegTotal).padEnd(3)} 命中`);
console.log(`  现役建仓策略 ACTIVE_STYLES = [${ACTIVE_STYLES.join(", ")}]；已淘汰 = [${RETIRED_STYLES.join(", ")}]`);
console.log("  → short 腿（热点·题材补涨 = relay）已被淘汰、记账进程不建仓，0 命中是设计使然，不是丢单。");

console.log("\n【落盘口径核查】");
const cur = reviewed.get(dates[dates.length - 1])!;
const withOrder = cur.signals.filter((s) => s.order != null).length;
const withFill = cur.signals.filter((s) => s.fill != null).length;
console.log(`  最新 reviewed.json 落盘：order 字段 ${withOrder}/${cur.signals.length} · fill 字段 ${withFill}/${cur.signals.length}（0 = 理论成交只回页面、不落盘）`);
