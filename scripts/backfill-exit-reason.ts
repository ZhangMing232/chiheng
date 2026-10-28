/**
 * 这个文件是干什么的：
 * 给历史已平仓交易回填 `exitReason`（一次性脚本）。
 * 失败归因（src/lib/market/loss-attrib.ts）按 stop / time / target 分 cause，
 * 而这个字段 2026-10-28 才开始落盘——之前的 173 笔已平仓全都没有，
 * 归因页只能把它们堆成一个「原因不明 148 笔」的大桶，等于没有归因。
 *
 * 跑法：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/backfill-exit-reason.ts
 *   加 --dry 只出报告，不写账本。
 *
 * 你需要知道的（这是本脚本的全部诚实性所在）：
 * **四档证据，分开标来源，绝不混算。** 写进账本的是 `exitReasonSource`：
 *
 *   1. `replayed` —— 日线撮合（exitKind="daily"）。
 *      用当初同一个 `exitFill` 拿历史 K 线重跑一遍。这是最硬的一档，
 *      但仍是**事后重算**不是原始记录。验收条件：重跑出来的成交日必须和账本
 *      exitDate 相同、价格差 ≤1%。
 *   2. `recorded_price` —— 盘中快照（exitKind="intraday"，86 笔）。
 *      **这一档不是推测，是记账公式的逆运算**：intraday-fill.ts 里
 *      `price <= stop → 记 price`、`price >= target → 记 target`。
 *      所以账本里 exit <= stop 就一定是止损触发、exit >= target 就一定是止盈触发，
 *      没有第二种可能。落在中间的（0 笔）说明公式解释不了，不猜、不写。
 *   3. `recorded_price_partial` —— 日线，但**结账时当天的 K 线还没走完**（10 笔）。
 *      这类重放对不上（差 1%~10%），查下来是因为 `exitFill` 到期那天用的是
 *      `bar.c`，而结算发生在当天盘中——bar.c 当时是现价，当天收盘价后来变了。
 *      判据：账本价落在**当天真实最高最低区间内** + 那天不是跌停封死 ⇒ 原因按账本价
 *      反解（这三条不等式同样是唯一解），但**这笔的价格是当时没走完的价格**，
 *      所以单独一档，别和 1 混着用。（这个口径问题另见 PRE-FIX-NOTE.md 补记。）
 *   4. `legacy_planned` —— 2026-10-08 之前的旧口径（无 exitKind，36 笔）。
 *      那会儿记账是 `hit === "stop" ? plan.stop : plan.target`，
 *      也就是**账本上的退出价就是计划价本身**（见 data/books/PRE-FIX-NOTE.md）。
 *      所以「exit 恰好等于 stop」证明它是止损出场。但注意：**这一档的价格不可信**
 *      （系统性偏乐观，实测虚记 4.5~9.5 个百分点），只能取「原因」不能取「幅度」。
 *      既不等 stop 也不等 target 的那 1 笔走的是 exitFill 到期路径 → time。
 *
 * - **不改任何金额字段**：entry / exit / exitDate / stop / target 一律不动。
 *   只加三个字段：exitReason、exitReasonSource、exitReasonAt。
 * - 幂等：已有 exitReason 的跳过，重复跑不会覆盖你手动改过的值。
 * - **跑之前先备份**（backupJournal），备份名带 before-backfill 后缀，
 *   不会被 pruneBackups 的 journal-YYYY-MM-DD 规则清掉。
 * - 记账进程每分钟会整本重写账本，所以本脚本**先把网络全抓完、再在最后
 *   一口气读改写**（毫秒级窗口），写完立刻回读校验。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupJournal } from "@/lib/market/journal-backup";
import { OWNER_ID, readUserBook, writeUserBook, type StoredBook } from "@/lib/market/book-file";
import { exitFill } from "@/lib/market/journal-book";
import { boardLimit, HOLD_SESSIONS } from "@/lib/market/model";
import { shanghaiDate } from "@/lib/market/session";
import type { Bar } from "@/lib/market/types";

/** 退出原因来源。写进账本，归因页据此分档展示，防止把重算当原始记录。 */
type ReasonSource = "replayed" | "recorded_price" | "recorded_price_partial" | "legacy_planned";

type Trade = {
  id: string;
  code?: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  hold?: number;
  exit: number | null;
  exitDate: string | null;
  exitKind?: "intraday" | "daily";
  exitReason?: string;
  exitReasonSource?: ReasonSource | string;
  exitReasonAt?: string;
};

/** 账本里的「天」。其余字段原样带走（本脚本只碰 trade.exitReason*，不碰任何金额）。 */
type Day = {
  date: string;
  savedAt?: number;
  signalTime?: string;
  status?: string;
  ruleVersion?: number;
  indexEntry?: number | null;
  indexExit?: number | null;
  trades: Trade[];
};

/** 重放结论和账本价格的允许偏差。超了就当数据变过，不写。 */
const REPLAY_TOLERANCE = 0.01;

const CACHE_CONCURRENCY = 3;

/** 带表头和超时的 K 线抓取（腾讯 ifzq，和 quotes.functions.ts 的 loadKline 同一个源）。 */
async function fetchBars(id: string): Promise<Bar[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,120`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      referer: "https://gu.qq.com/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  const node = body.data?.[id];
  const rows = node?.qfqday ?? node?.day ?? [];
  const bars: Bar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const o = Number(row[1]);
    const c = Number(row[2]);
    const h = Number(row[3]);
    const l = Number(row[4]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    bars.push({ date: row[0] ?? "", o, c, h, l, v: Number(row[5]) || 0 } as Bar);
  }
  return bars;
}

type FetchResult = { bars: Bar[] } | { error: string };

/** 限并发抓 K 线，失败的退一次。 */
async function fetchAll(ids: string[]): Promise<Map<string, FetchResult>> {
  const out = new Map<string, FetchResult>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      const id = ids[index];
      let last = "";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const bars = await fetchBars(id);
          if (bars.length === 0) throw new Error("K 线为空");
          out.set(id, { bars });
          break;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      if (!out.has(id)) out.set(id, { error: last || "抓取失败" });
      process.stdout.write(`\r  抓 K 线 ${out.size}/${ids.length}`);
    }
  };
  await Promise.all(Array.from({ length: CACHE_CONCURRENCY }, worker));
  process.stdout.write("\n");
  return out;
}

type Replay =
  | { ok: true; reason: "stop" | "target" | "time"; price: number; date: string }
  /** 同一天、同一条规则，但重放价和账本差太多（见下面 drift 说明）。 */
  | { ok: false; drift: { reason: "stop" | "target" | "time"; price: number; date: string }; why: string }
  /** 重放根本对不上（没有买入日 / 日期不同 / 缺字段）。 */
  | { ok: false; why: string };

/** 日线撮合重放：拿当初同一套 exitFill 在历史 K 线上重跑一遍。 */
function replayDaily(day: Day, trade: Trade, bars: Bar[]): Replay {
  if (trade.stop == null || trade.target == null) return { ok: false, why: "账本缺 stop/target" };
  const hold = trade.hold ?? HOLD_SESSIONS;
  const filled = exitFill(
    bars as Bar[],
    day.date,
    trade.entry,
    trade.stop,
    trade.target,
    boardLimit(trade.id, trade.name),
    hold,
  );
  if (!filled) return { ok: false, why: "重放没有成交（K 线里没有买入日，或窗口不够）" };
  if (trade.exitDate && filled.date !== trade.exitDate) {
    return { ok: false, why: `重放成交日 ${filled.date} ≠ 账本 ${trade.exitDate}` };
  }
  const recorded = trade.exit ?? 0;
  const drift = Math.abs(filled.price - recorded) / recorded;
  if (recorded > 0 && drift > REPLAY_TOLERANCE) {
    return {
      ok: false,
      drift: { reason: filled.reason, price: filled.price, date: filled.date },
      why: `重放价 ${filled.price} 与账本 ${recorded} 差 ${(drift * 100).toFixed(2)}%`,
    };
  }
  return { ok: true, reason: filled.reason, price: filled.price, date: filled.date };
}

/**
 * 从**账本记下的退出价**反解原因（exitFill 的逆运算）：
 * 只有 `(last||forced) && bar.c > 0` 这条路会记一个「既不在止损也不在止盈」的价格，
 * 而它的 reason 是 time；止损只会记 stop（或跳空时的开盘价 ≤ stop），
 * 止盈只会记 target。所以三条不等式是唯一解，不是猜。
 *
 * 唯一失效的场景是「跌停封死宽限期最后一天按收盘价结掉」——那天 bar.c 可能远低于
 * 止损，price ≤ stop 会误判成 stop。调用方用 sealedDown 挡掉那天（见 daily 分支）。
 */
function classifyFromPrice(trade: Trade): "stop" | "target" | "time" | null {
  const exit = trade.exit ?? 0;
  if (exit <= 0 || trade.stop == null || trade.target == null) return null;
  if (exit <= trade.stop) return "stop";
  if (exit >= trade.target) return "target";
  return "time";
}

/** 这根 K 线是不是跌停封死（收盘≈最高≈跌停价）。封死那天从价格反解不可靠。 */
function sealedDownBar(bars: Bar[], date: string, limitPct: number | null): boolean {
  if (limitPct == null) return false;
  const index = bars.findIndex((bar) => bar.date === date);
  if (index <= 0) return false;
  const prev = bars[index - 1].c;
  const bar = bars[index];
  if (!(prev > 0) || !(bar.c > 0)) return false;
  const down = Math.round(prev * (1 - limitPct / 100) * 100) / 100;
  return bar.c <= down + 0.01 && (bar.h == null || bar.h <= down + 0.01);
}

/** 账本价是否落在这一天的真实价格区间内（说明它是当天的价，只是当时还没定型）。 */
function insideDayRange(bars: Bar[], date: string, price: number): boolean {
  const bar = bars.find((item) => item.date === date);
  if (!bar) return false;
  const high = bar.h != null && bar.h > 0 ? bar.h : bar.c;
  const low = bar.l != null && bar.l > 0 ? bar.l : bar.c;
  return price >= low * 0.995 && price <= high * 1.005;
}

type Plan = {
  day: string;
  trade: Trade;
  reason?: "stop" | "target" | "time";
  source?: ReasonSource;
  note?: string;
  skipped?: string;
};

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const today = shanghaiDate();
  const report: string[] = [];
  const say = (line: string): void => {
    report.push(line);
    console.log(line);
  };

  const book = await readUserBook<Day>(OWNER_ID);
  const closed: { day: Day; trade: Trade }[] = [];
  for (const day of book.days) {
    for (const trade of day.trades ?? []) {
      if (trade.exit != null) closed.push({ day, trade });
    }
  }
  say(`账本 ${OWNER_ID}：${book.days.length} 天，已平仓 ${closed.length} 笔`);
  say(`已有 exitReason：${closed.filter(({ trade }) => trade.exitReason).length} 笔`);

  const todo = closed.filter(({ trade }) => !trade.exitReason);
  if (todo.length === 0) {
    say("没有需要回填的交易。");
    return;
  }
  const byKind = {
    daily: todo.filter(({ trade }) => trade.exitKind === "daily").length,
    intraday: todo.filter(({ trade }) => trade.exitKind === "intraday").length,
    legacy: todo.filter(({ trade }) => trade.exitKind == null).length,
  };
  say(`待回填 ${todo.length} 笔：日线重放 ${byKind.daily}、盘中反解 ${byKind.intraday}、旧口径反推 ${byKind.legacy}`);

  // ① 先把网络抓完（不在持有账本快照的情况下长时间等待）
  const ids = Array.from(new Set(todo.filter(({ trade }) => trade.exitKind === "daily").map(({ trade }) => trade.id)));
  say(`\n抓 K 线 ${ids.length} 只（日线重放用）…`);
  const bars = await fetchAll(ids);

  // ② 逐笔定原因
  const plans: Plan[] = [];
  for (const { day, trade } of todo) {
    if (trade.exitKind === "daily") {
      const got = bars.get(trade.id);
      if (!got || "error" in got) {
        plans.push({ day: day.date, trade, skipped: `K 线抓不到（${got && "error" in got ? got.error : "无数据"}）` });
        continue;
      }
      const replayed = replayDaily(day, trade, got.bars);
      if (replayed.ok) {
        plans.push({
          day: day.date,
          trade,
          reason: replayed.reason,
          source: "replayed",
          note: `重放 ${replayed.date} @ ${replayed.price}`,
        });
        continue;
      }
      if ("drift" in replayed) {
        // 重放拿的是**今天的定型 K 线**，而当初结账时这根 K 线可能还没走完。
        // 判据：账本价落在当天真实区间内 + 那天不是跌停封死 ⇒ 当天盘中就结的账，
        // 原因以账本价本身为准（反解），重放价只说明「后来价格走掉了」。
        const date = trade.exitDate ?? "";
        const limit = boardLimit(trade.id, trade.name);
        const inside = date ? insideDayRange(got.bars, date, trade.exit ?? 0) : false;
        if (inside && !sealedDownBar(got.bars, date, limit)) {
          const reason = classifyFromPrice(trade);
          if (reason) {
            plans.push({
              day: day.date,
              trade,
              reason,
              source: "recorded_price_partial",
              note: `${replayed.why}；账本价在当日区间内（当日盘中结账，K 线未定型），按账本价反解`,
            });
            continue;
          }
        }
        plans.push({
          day: day.date,
          trade,
          skipped: `${replayed.why}，且账本价不在当日区间内或当日跌停封死——重放不可复现`,
        });
        continue;
      }
      plans.push({ day: day.date, trade, skipped: replayed.why });
      continue;
    }
    if (trade.exitKind === "intraday") {
      const reason = classifyFromPrice(trade);
      if (!reason) {
        plans.push({ day: day.date, trade, skipped: "退出价落在 stop 与 target 之间，intradayFill 解释不了" });
        continue;
      }
      plans.push({ day: day.date, trade, reason, source: "recorded_price" });
      continue;
    }
    const reason = classifyFromPrice(trade);
    if (!reason) {
      plans.push({ day: day.date, trade, skipped: "账本缺 stop/target" });
      continue;
    }
    plans.push({ day: day.date, trade, reason, source: "legacy_planned" });
  }

  const willWrite = plans.filter((plan) => plan.reason);
  const skipped = plans.filter((plan) => plan.skipped);

  // ③ 报告（先出，写账本前就能看）
  say(`\n=== 将要写入 ${willWrite.length} 笔 ===`);
  const tally = new Map<string, { n: number; source: ReasonSource }>();
  for (const plan of willWrite) {
    const key = `${plan.reason}|${plan.source}`;
    const cur = tally.get(key) ?? { n: 0, source: plan.source! };
    tally.set(key, { n: cur.n + 1, source: plan.source! });
  }
  for (const [key, value] of [...tally].sort((a, b) => b[1].n - a[1].n)) {
    const [reason] = key.split("|");
    say(`  ${reason.padEnd(7)} ${String(value.n).padStart(3)} 笔  ← ${value.source}`);
  }

  if (skipped.length > 0) {
    say(`\n=== 不写（${skipped.length} 笔，留作 unknown_legacy）===`);
    const why = new Map<string, number>();
    for (const plan of skipped) {
      why.set(plan.skipped!, (why.get(plan.skipped!) ?? 0) + 1);
    }
    for (const [reason, n] of [...why].sort((a, b) => b[1] - a[1])) {
      say(`  ${String(n).padStart(3)} 笔：${reason}`);
    }
    say("  明细：");
    for (const plan of skipped.slice(0, 20)) {
      say(`    ${plan.day} ${plan.trade.id} ${plan.trade.name} exit=${plan.trade.exit} → ${plan.skipped}`);
    }
    if (skipped.length > 20) say(`    …另有 ${skipped.length - 20} 笔`);
  }

  // ④ 当日盘中结账的那批单独列出来：原因是真原因，但**价格是当时没走完的价格**
  const drifted = willWrite.filter((plan) => plan.note?.startsWith("重放价"));
  if (drifted.length > 0) {
    say(`\n=== ${drifted.length} 笔「结账时当日 K 线还没走完」（原因取账本价反解，重放价只作对照）===`);
    for (const plan of drifted) {
      say(`  ${plan.day} ${plan.trade.id} ${plan.trade.name} 账本 exit=${plan.trade.exit} → ${plan.reason}`);
      say(`      ${plan.note}`);
    }
  }

  // ⑤ 旧口径单独警告：这一档价格不可信
  const legacyCount = willWrite.filter((plan) => plan.source === "legacy_planned").length;
  if (legacyCount > 0) {
    say(
      `\n⚠️ 其中 ${legacyCount} 笔是 2026-10-08 旧口径反推：退出价就是计划价本身，` +
        "**只能取「原因」，不能取「幅度」**（见 data/books/PRE-FIX-NOTE.md）。",
    );
  }

  if (dry) {
    say("\n--dry：不写账本。");
    await writeReport(report, today);
    return;
  }

  // ⑥ 备份 → 重读 → 覆盖 → 写回 → 回读校验（窗口越小越好，记账进程每分钟整本重写）
  const backup = await backupJournal(OWNER_ID, `${today}-before-backfill`);
  if (!backup.ok) {
    say(`\n备份失败，中止：${backup.reason}`);
    await writeReport(report, today);
    process.exitCode = 1;
    return;
  }
  say(`\n备份：${backup.path}`);

  const fresh = await readUserBook<Day>(OWNER_ID);
  const byKey = new Map<string, Plan>();
  for (const plan of willWrite) byKey.set(`${plan.day}:${plan.trade.id}`, plan);

  let written = 0;
  for (const day of fresh.days) {
    for (const trade of day.trades ?? []) {
      const plan = byKey.get(`${day.date}:${trade.id}`);
      if (!plan || plan.reason == null) continue;
      if (trade.exitReason) continue;
      trade.exitReason = plan.reason;
      trade.exitReasonSource = plan.source;
      trade.exitReasonAt = today;
      written += 1;
    }
  }
  await writeUserBook<Day>(OWNER_ID, fresh as StoredBook<Day>);

  const check = await readUserBook<Day>(OWNER_ID);
  let confirmed = 0;
  for (const day of check.days) {
    for (const trade of day.trades ?? []) {
      const plan = byKey.get(`${day.date}:${trade.id}`);
      if (plan?.reason && trade.exitReason === plan.reason) confirmed += 1;
    }
  }
  say(`写入 ${written} 笔，回读确认 ${confirmed} 笔${confirmed === written ? " ✅" : " ❌ 不一致，检查是否被记账进程覆盖"}`);
  await writeReport(report, today);
}

async function writeReport(lines: string[], today: string): Promise<void> {
  const dir = join(process.cwd(), "data", "backtest");
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `exit-reason-backfill-${today}.txt`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    console.log(`\n报告：${path}`);
  } catch (error) {
    console.log(`\n报告写失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

void main();
