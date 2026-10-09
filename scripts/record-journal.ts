/**
 * 这个文件是干什么的：
 * 纸面记账。交易时段里，现价碰到计划买入价才记一笔；之后碰到卖出价或止损价就结算。
 *
 * 你需要知道的：
 * 本机服务起来时会立刻跑一遍，之后大约每分钟再跑一遍（由 home-server.mjs 定时拉起）。
 * 只在交易日、行情对得上的时候才会按计划价记入新的买入。买入价写下后不再改。
 * 同一天卖出价和止损价都碰到，按止损结算；都没碰到，就等到第 8 个交易日收盘再结算。
 * 结果写在 data/books，并复制一份到用户目录下的 chiheng-backup。主人账号会收到 Mac 通知。
 * 不会连接券商，不会下真实委托。改选股规则不要从这里下手。
 */

// 交易时段里，现价打到这只股票的买入价才记入。买入价写下后不再改。
// 之后碰到卖出价或止损价就结算；同一天两边都碰到按止损。否则等第 8 个交易日收盘。
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { OWNER_ID, listUserIds, readUserBook, writeUserBook, type StoredBook } from "../src/lib/market/book-file.ts";
import { exitFill, hardGate, nthClose, softGate, dayReliable, netReturn } from "../src/lib/market/journal-book.ts";
import { evaluateGate, readStrategyGates, writeStrategyGates } from "../src/lib/market/strategy-gate.ts";
import { appendGateLog } from "../src/lib/market/gate-log.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { boardLimit, HOLD_SESSIONS, limitTag, planExit } from "../src/lib/market/model.ts";
import { ACTIVE_STYLES, holdOf, STYLES, styleOf, takeBuys, watchList } from "../src/lib/market/strategies.ts";
import { loadRelay } from "../src/lib/market/sectors.ts";
import { formatClock, isTradingDay, sessionPhase } from "../src/lib/market/session.ts";
import { intradayFill } from "../src/lib/market/intraday-fill.ts";
import { sendPushPlus } from "../src/lib/market/push.ts";

type Trade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: "early" | "trend" | "breakout" | "value" | "relay" | "rebound";
  hold?: number;
  exit: number | null;
  exitDate: string | null;
  /**
   * 卖出价是「盘中现价快照」还是「日线撮合」。没这个字段 = 2026-10-08 之前的旧账。
   *
   * 两者可信度不同：盘中只有触发那一刻的现价，没有开盘价也没有 high/low，跳空穿
   * 止损只能按现价记；日线才有完整的跳空修正。**不要把两者混在一起算统计**——
   * 旧账的卖出价一律是计划价、账面系统性偏乐观（见 data/books/PRE-FIX-NOTE.md）。
   */
  exitKind?: "intraday" | "daily";
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

type Book = StoredBook<Day>;

const pulsePath = join(process.cwd(), "data", "recorder.json");
const alertPath = join(process.cwd(), "data", "sell-alerts.json");
const navPath = join(process.cwd(), "data", "nav-history.json");
const backupDir = join(homedir(), "chiheng-backup");

/**
 * 净值定义：等权逐笔平均。已平仓按 (exit-entry)/entry，持仓按 (现价-entry)/entry，
 * nav = 1 + 所有笔收益的平均。index 记当天沪深300原始点位，benchmark 由读取方
 * 对首个有记录交易日归一。按日去重（同一天重跑覆盖旧点），最多留 500 个交易日。
 */
type NavPoint = { date: string; nav: number; index: number | null };

async function appendNav(userId: string, point: NavPoint) {
  let all: Record<string, NavPoint[]> = {};
  try {
    const parsed = JSON.parse(await readFile(navPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) all = parsed;
  } catch {
    all = {};
  }
  const mine = Array.isArray(all[userId]) ? all[userId] : [];
  all[userId] = [...mine.filter((item) => item.date !== point.date), point]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-500);
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(navPath, JSON.stringify(all));
}

function notify(body: string) {
  if (process.platform !== "darwin") return;
  execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify("赤轨")}`], () => undefined);
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

async function backup(userId: string, date: string) {
  const from = join(process.cwd(), "data", "books", `${userId}.json`);
  try {
    await access(from);
  } catch {
    return;
  }
  const dir = join(backupDir, userId);
  await mkdir(dir, { recursive: true });
  await copyFile(from, join(dir, `journal-${date}.json`));
}

let failing = false;
process.on("unhandledRejection", (err) => {
  console.error(err);
  if (failing) process.exit(1);
  failing = true;
  void mark(false).finally(() => process.exit(1));
});

const rules = await readRules();
const prefs = await readPrefs();
const phase = sessionPhase();
const time = formatClock(Date.now());
const alerts = await readAlerts();
let alertsChanged = false;

// ── 策略级自动闸门（冠军-挑战者的第一步：自动判决 + 自动停用/假释/恢复）────
// 判决标准预先登记在 strategy-gate.ts 的 STRATEGY_GATE（20 笔窗口、t≤−2 停用、
// 冷却 10 个交易日起步、再犯翻倍封顶 40）。数据来自主人账本的已平仓样本
// （扣费、只数信号日可信的天），每套 ACTIVE 策略独立判决。
// 状态落盘 data/strategy-gates.json：记账进程每分钟新起一个，进程内状态不算数。
const strategyGates = await readStrategyGates();
const gateDisabled = new Set(
  Object.entries(strategyGates)
    .filter(([, record]) => record.state === "disabled")
    .map(([style]) => style),
);
const gateParoled = new Set(
  Object.entries(strategyGates)
    .filter(([, record]) => record.state === "paroled")
    .map(([style]) => style),
);
if (phase.date) {
  const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
  if (ownerBook) {
    const retsByStyle = new Map<string, number[]>();
    for (const day of ownerBook.days) {
      if (!dayReliable(day)) continue;
      for (const trade of day.trades) {
        if (trade.exit == null) continue;
        const style = styleOf(trade);
        if (!style) continue;
        const ret = netReturn(trade.entry, trade.exit);
        if (ret == null) continue;
        const list = retsByStyle.get(style) ?? [];
        list.push(ret);
        retsByStyle.set(style, list);
      }
    }
    let gatesChanged = false;
    for (const style of ACTIVE_STYLES) {
      const decision = evaluateGate({
        rets: retsByStyle.get(style) ?? [],
        record: strategyGates[style] ?? null,
        today: phase.date,
      });
      if (decision.action === "none") continue;
      gatesChanged = true;
      if (decision.next) strategyGates[style] = decision.next;
      else delete strategyGates[style];
      if (decision.action === "disable") {
        gateDisabled.add(style);
        gateParoled.delete(style);
      } else if (decision.action === "parole") {
        gateDisabled.delete(style);
        gateParoled.add(style);
      } else {
        gateDisabled.delete(style);
        gateParoled.delete(style);
      }
      const name = STYLES.find((item) => item.id === style)?.name ?? style;
      const label =
        decision.action === "disable" ? "已自动停用" : decision.action === "parole" ? "假释观察（每天限 1 只）" : "恢复满仓";
      console.log(`strategy-gate ${style} ${decision.action}: ${decision.reason}`);
      notify(`${name} ${label}：${decision.reason}`);
      void sendPushPlus("赤轨策略闸门", `${name} ${label}\n${decision.reason}\n时间：${time}`);
    }
    if (gatesChanged) await writeStrategyGates(strategyGates);
  }
}

let universe: Awaited<ReturnType<typeof loadUniverse>> | null = null;
let indexPrice: number | null = null;
let relay: Awaited<ReturnType<typeof loadRelay>> = [];
if (phase.date && isTradingDay(phase.date) && phase.matching) {
  // 只有真正要用最新价格的两段才强制重拉：早盘买入窗口（9:25–9:30）、
  // 尾盘买入窗口（14:40–15:00），以及次日补涨冻结名单的 14:30 之后。
  // 其余时间三分钟一份就够了——这些策略持股 10 个交易日，差三分钟不影响任何判断，
  // 而每分钟全量拉 5200 多只股票会把腾讯接口顶到 WAF（K 线返回 501，结算就卡住）。
  const needFresh = phase.entry !== "none" || phase.tailHalf;
  universe = await loadUniverse(needFresh);
  const indices = await loadIndices();
  const index = indices.find((item) => item.id === "sh000300");
  indexPrice = index && index.price > 0 ? index.price : null;
  try {
    relay = await loadRelay(phase.tailHalf, phase.date);
  } catch {
    relay = [];
  }
}

const klines = new Map<string, Awaited<ReturnType<typeof loadKline>>>();
async function kline(id: string) {
  const saved = klines.get(id);
  if (saved) return saved;
  const data = await loadKline(id);
  klines.set(id, data);
  return data;
}

async function runBook(userId: string, book: Book): Promise<boolean> {
  const speak = userId === OWNER_ID;
  let days = book.days;
  let changed = false;
  const tagged = days.map((day) => ({ ...day, trades: day.trades.filter((trade) => styleOf(trade) != null) }));
  if (tagged.some((day, index) => day.trades.length !== days[index].trades.length)) changed = true;
  days = tagged.filter((day) => day.trades.length > 0);
  const canBuy = !book.joinedAt || !phase.date || book.joinedAt <= phase.date;

  // sealed 表示已经过了 15:00。收盘后不再记新仓：那时候拿到的是收盘快照，
  // 用它倒推「盘中是不是打到过买入价」会记下并不存在的成交（22:48 补记那种）。
  if (canBuy && universe && phase.date && !phase.sealed && universe.quotes.some((quote) => quote.amount > 0 && quote.turnover > 0)) {
    const held = days.flatMap((day) => day.trades);
    const existing = days.find((day) => day.date === phase.date);
    // 名额按天算：只数这一天已经记下的，前几天还没卖出的不占今天的名额。
    const todayTrades: Trade[] = existing ? [...existing.trades] : [];
    const additions: Trade[] = [];
    // 提示闸每天最多记一条，别刷屏
    let buysPresentThisRun = true;

    // ── 风控闸门 ──────────────────────────────────────────────
    // 以前这里什么都不查，「连亏就停手」只活在持仓页的一行文案里
    // （liveGate 全项目唯一调用点是 positions.tsx:200，record-journal 从不 import 它）。
    // 现在它是真的会执行的闸门。分两种：
    //   硬闸 = 策略在亏（连亏天数 / 最近 20 笔均值）→ 这一套今天不开仓
    //   提示闸 = 样本不够 → 只记一笔，不拦。样本少不是策略的错，拦了等于永远不许开始
    const closedForGate = days.flatMap((day) =>
      day.trades
        .filter((trade) => trade.exit != null)
        .map((trade) => ({ date: trade.exitDate ?? day.date, ret: (trade.exit! - trade.entry) / trade.entry })),
    );
    const hard = hardGate(closedForGate, rules);

    // 提示闸：样本不够只记一笔，不拦开仓。样本少不是策略的错——
    // 新策略刚上线必然样本少，拿这个当闸门等于「永远不许开始」。
    // 记下来的意义是：以后想说「这套行不行」时，能指出还差多少样本。
    if (!softGate(days.length, [], rules).ok) {
      const soft = softGate(days.length, [], rules);
      if (buysPresentThisRun) {
        appendGateLog({
          at: Date.now(),
          tradingDate: phase.date!,
          style: ACTIVE_STYLES[0],
          gate: "soft",
          reason: soft.reason,
          candidates: [],
        });
        buysPresentThisRun = false;
      }
    }

    // 只跑还在用的那几套。停掉的两套仍留在页面上查看，但不再自动建仓。
    // 策略闸停用的也跳过（evaluateGate 在上面判过）——只停新仓，下面的结算照跑。
    for (const style of ACTIVE_STYLES) {
      if (gateDisabled.has(style)) continue;
      const list =
        style === "relay"
          ? relay.filter((row) => matchPrefs(row.quote, prefs))
          : watchList(universe.quotes, style, rules, (quote) => matchPrefs(quote, prefs));
      // 假释中的策略限 1 只/天：它是带罪观察，不是无罪释放。
      const allBuys = takeBuys(list, held, style, todayTrades);
      const buys = gateParoled.has(style) ? allBuys.slice(0, 1) : allBuys;

      if (!hard.ok) {
        // 拦下之前先把「本来想买什么」记下来。不记的话事后只知道「今天没开仓」，
        // 没法判断闸门是不是拦过头了——而这是唯一能验证它合理性的办法。
        if (buys.length > 0) {
          appendGateLog({
            at: Date.now(),
            tradingDate: phase.date!,
            style,
            gate: "hard",
            reason: hard.reason,
            candidates: buys.map((row) => ({
              id: row.quote.id,
              name: row.quote.name,
              buy: row.buy,
              score: row.score,
            })),
          });
        }
        // 跳过这一套，继续跑别的——一套被拦不影响别的套。
        // 只停**开仓**，下面的结算段照常执行，持仓的止损止盈照管。
        continue;
      }

      for (const row of buys) {
        const trade: Trade = {
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop: row.stop,
          target: row.sell,
          style,
          // 持股天数查 strategies.ts 的 STYLE_HOLD（唯一定义处），不再在这里写三元字面量
          hold: holdOf(style),
          exit: null,
          exitDate: null,
        };
        additions.push(trade);
        held.push(trade);
        todayTrades.push(trade);
      }
    }
    if (additions.length > 0) {
      const next: Day = existing
        ? { ...existing, savedAt: Date.now(), trades: [...existing.trades, ...additions] }
        : {
            date: phase.date,
            savedAt: Date.now(),
            signalTime: time,
            status: phase.sealed ? "locked" : "provisional",
            ruleVersion: rules.version,
            indexEntry: indexPrice,
            indexExit: null,
            trades: additions,
          };
      days = existing ? days.map((day) => (day.date === phase.date ? next : day)) : [next, ...days].slice(0, 80);
      changed = true;
      if (speak) {
        const shown = additions.slice(0, 3).map((trade) => {
          const style = STYLES.find((item) => item.id === trade.style)?.name ?? "";
          return `${style} ${trade.name}`.trim();
        });
        const more = additions.length > shown.length ? `等 ${additions.length} 只` : "";
        notify(`${shown.join("、")}${more} 已到买入价`);
      }
      console.log(`bought ${userId} ${phase.date} ${additions.length}`);
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
        // 判定和记账用同一个价（intradayFill），曾经这里判定用现价、记账用计划价，
        // 账上虚记最多 9.5 个百分点，而 hardGate 读的就是这个数。详见 intraday-fill.ts。
        const fill = intradayFill(quote.price, plan.stop, plan.target);
        if (!fill) continue;
        const key = `${userId}:${day.date}:${trade.id}:${fill.reason}`;
        if (!alerts.has(key)) {
          alerts.add(key);
          alertsChanged = true;
          if (speak) (fill.reason === "stop" ? stops : targets).push(label);
        }
        trade.exit = fill.price;
        trade.exitDate = phase.date;
        trade.exitKind = "intraday";
        changed = true;
      }
    }
    if (speak) {
      notifyNames("到止损价", stops);
      notifyNames("到卖出价", targets);
      // PushPlus 微信推送：和 Mac 通知同一份名单（stops/targets 只在新预警出现时才有内容）。
      if (stops.length > 0 || targets.length > 0) {
        void sendPushPlus(
          "赤轨预警",
          [
            ...(stops.length > 0 ? [`到止损价：${stops.join("、")}`] : []),
            ...(targets.length > 0 ? [`到卖出价：${targets.join("、")}`] : []),
            `时间：${time}`,
          ].join("\n"),
        );
      }
    }
  }

  const pending = days.some(
    (day) => day.trades.some((trade) => trade.exit == null) || (day.indexEntry != null && day.indexExit == null),
  );
  const settleDue = pending && (book.nextSettleAt == null || Date.now() >= book.nextSettleAt);
  let nextSettleAt = book.nextSettleAt;
  if (settleDue && phase.date) {
    let stillOpen = false;
    const due: string[] = [];
    const stuck: string[] = [];
    for (const day of days) {
      for (const trade of day.trades) {
        if (trade.exit != null) continue;
        try {
          const data = await kline(trade.id);
          const plan = trade.stop && trade.target ? { stop: trade.stop, target: trade.target } : planExit(trade.entry, null, rules);
          const filled = exitFill(
            data.bars,
            day.date,
            trade.entry,
            plan.stop,
            plan.target,
            boardLimit(trade.id, trade.name),
            trade.hold ?? HOLD_SESSIONS,
          );
          if (!filled) {
            stillOpen = true;
            const bars = data.bars;
            // 「算不出来」有两种，得分开说，不然天天误报：
            // 一是还没到卖出日（正常得很，09-30 建的仓拿到今天才 3 个交易日）；
            // 二是真的卡住了——买入日不在这 120 根 K 线里（停牌很久、或者持仓比
            // K 线窗口还早），这种才会永远挂着、占着名额、不进胜率，页面上也看不出来。
            // 早先一律报「会一直挂着」，结果每次都拿几十笔正常持仓刷一条假警报。
            if (!bars.some((bar) => bar.date === day.date)) {
              stuck.push(`${trade.name} ${day.date}（K 线里没有买入日这根，最早 ${bars[0]?.date ?? "无"}）`);
              continue;
            }
            const hold = trade.hold ?? HOLD_SESSIONS;
            const passed = bars.filter((bar) => bar.date > day.date).length;
            if (passed < hold) continue;
            stuck.push(`${trade.name} ${day.date}（已过 ${passed} 个交易日仍算不出卖出价）`);
            continue;
          }
          trade.exit = filled.price;
          trade.exitDate = filled.date;
          trade.exitKind = "daily";
          changed = true;
          const key = `${userId}:${day.date}:${trade.id}:${filled.reason}`;
          if (filled.reason === "time" && !alerts.has(key)) {
            alerts.add(key);
            alertsChanged = true;
            if (speak) {
              const style = STYLES.find((item) => item.id === trade.style)?.name ?? "";
              due.push(`${style} ${trade.name}`.trim());
            }
          }
        } catch {
          stillOpen = true;
        }
      }
      if (day.indexExit == null && day.indexEntry != null) {
        try {
          const data = await kline("sh000300");
          // 这一天里的持仓拿的天数并不一样（次日补涨 1 天、多数 8 天、中期反转 10 天），
          // 而指数对照一天只有一个数。取最长的那个：指数多走几天等于多给了它一点涨幅，
          // 往对自己不利的方向偏，不至于把「跑赢沪深300」说得比实际好看。
          const longest = day.trades.reduce((max, trade) => Math.max(max, trade.hold ?? HOLD_SESSIONS), HOLD_SESSIONS);
          const next = nthClose(data.bars, day.date, longest);
          if (next) {
            day.indexExit = next.price;
            changed = true;
          } else stillOpen = true;
        } catch {
          stillOpen = true;
        }
      }
    }
    nextSettleAt = Date.now() + (stillOpen ? 30 * 60_000 : 12 * 60 * 60_000);
    changed = true;
    if (speak) {
      notifyNames("到期该卖", due);
      if (due.length > 0) void sendPushPlus("赤轨预警", [`到期该卖：${due.join("、")}`, `时间：${time}`].join("\n"));
    }
    if (stuck.length > 0) {
      console.log(`${time} 有 ${stuck.length} 笔结算不出来，会一直挂着：${stuck.slice(0, 5).join("；")}`);
    }
  }

  // ── 净值沉淀：每个收盘记一个点 ────────────────────────────
  // 设计稿主控台/策略追踪页的净值曲线从这里来。收盘后（sealed）记一次，
  // 同一天重跑覆盖旧点，不会重复。持仓用本轮拿到的现价；没拿到价的笔不进平均，
  // 宁可少算不编数。
  if (phase.sealed && phase.date && isTradingDay(phase.date) && indexPrice != null) {
    const rets: number[] = [];
    for (const trade of days.flatMap((day) => day.trades)) {
      if (trade.exit != null) rets.push((trade.exit - trade.entry) / trade.entry);
      else {
        const quote = universe?.quotes.find((item) => item.id === trade.id);
        if (quote && quote.price > 0) rets.push((quote.price - trade.entry) / trade.entry);
      }
    }
    if (rets.length > 0) {
      const nav = 1 + rets.reduce((sum, ret) => sum + ret, 0) / rets.length;
      await appendNav(userId, { date: phase.date, nav, index: indexPrice });
    }
  }

  if (changed) await writeUserBook(userId, { joinedAt: book.joinedAt, days, nextSettleAt });
  return changed;
}

const ids = await listUserIds();
let any = false;
for (const userId of ids) {
  const book = await readUserBook<Day>(userId);
  if (await runBook(userId, book)) any = true;
}
if (!any) console.log(`${time} ${phase.label} no change`);
if (alertsChanged) await writeAlerts(alerts);

await mark(true);
const backupDate = phase.date || new Date().toISOString().slice(0, 10);
for (const userId of ids) {
  const backupPath = join(backupDir, userId, `journal-${backupDate}.json`);
  let backed = false;
  try {
    await access(backupPath);
    backed = true;
  } catch {
    backed = false;
  }
  if (any || (phase.sealed && !backed)) await backup(userId, backupDate);
}
