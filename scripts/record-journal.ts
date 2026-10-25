/**
 * 这个文件是干什么的：
 * 纸面记账。交易时段里，现价碰到计划买入价才记一笔；之后碰到卖出价或止损价就结算。
 *
 * 你需要知道的：
 * 本机服务起来时会立刻跑一遍，之后大约每分钟再跑一遍（由 home-server.mjs 定时拉起）。
 * 只在交易日、行情对得上的时候才会按计划价记入新的买入。买入价写下后不再改。
 * 同一天卖出价和止损价都碰到，按止损结算；都没碰到，就等到第 8 个交易日收盘再结算。
 * 结果写在 data/books，并复制一份到用户目录下的 chiheng-backup。主人账号会收到 Mac 通知。
 * 收盘封印后还会每个交易日发一封每日复盘邮件（诊断摘要/挑战者战况/明日验证，
 * 配了 data/mail-config.json 才发；没配静默跳过）。
 * 选股候选（含没成交的）每天留痕在 data/signals.jsonl——账本只有成交，
 * 那份日志补上「选了没买」的分母，用来量选择偏差。
 * 不会连接券商，不会下真实委托。改选股规则不要从这里下手。
 */

// 交易时段里，现价打到这只股票的买入价才记入。买入价写下后不再改。
// 之后碰到卖出价或止损价就结算；同一天两边都碰到按止损。否则等第 8 个交易日收盘。
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKUP_KEEP_DAYS, backupJournal, pruneBackups } from "@/lib/market/journal-backup";
import { OWNER_ID, listUserIds, readUserBook, writeUserBook, type StoredBook } from "../src/lib/market/book-file.ts";
import { hardGate, nthClose, softGate, dayReliable, netReturn } from "../src/lib/market/journal-book.ts";
import { isStuck, settleOne } from "@/lib/market/settle";
import { evaluateGate, readStrategyGates, writeStrategyGates } from "../src/lib/market/strategy-gate.ts";
import {
  appendChampionLog,
  bucketReturns,
  judgeChallenger,
  readChallengers,
  readChampions,
  tradingDaysSince,
  writeChallengers,
  writeChampions,
  type Challenger,
} from "../src/lib/market/challenger.ts";
import { appendGateLog } from "../src/lib/market/gate-log.ts";
import { appendSignals } from "../src/lib/market/signal-log.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { HOLD_SESSIONS, limitTag, planExit } from "../src/lib/market/model.ts";
import { ACTIVE_STYLES, holdOf, STYLES, styleOf, takeBuys, takeChallengerBuy, watchList } from "../src/lib/market/strategies.ts";
import { loadRelay } from "../src/lib/market/sectors.ts";
import { formatClock, isTradingDay, sessionPhase } from "../src/lib/market/session.ts";
import { intradayFill } from "../src/lib/market/intraday-fill.ts";
import { sendPushPlus } from "../src/lib/market/push.ts";
import { readAIPrefs } from "../src/lib/market/ai-prefs.ts";
import { readAILog } from "../src/lib/market/ai-log.ts";
import { readFactorRuns } from "../src/lib/market/factor-runs-file.ts";
import { readAIConfig, runFactorAILoop } from "../src/lib/market/factor-queue.ts";
import { runStrategyAILoop } from "../src/lib/market/strategy-ai.ts";
import { robustnessReport, writeRobustness } from "../src/lib/market/challenger-robust.ts";
import { FACTORS } from "../src/lib/market/factors.ts";

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
  /** 挑战者 id。缺省 = 冠军参数。归因和判决按这个字段把两边分开。 */
  variant?: string;
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

/**
 * 备份账本（2026-10-13 E3 加固，逻辑搬到 src/lib/market/journal-backup.ts）。
 *
 * 原版三个问题：失败会抛（被 unhandledRejection 接住直接 exit(1)，备份是冗余
 * 不该有让记账进程陪葬的权力）；无轮换（每天一份永不清理）；无校验（复制到一半的
 * 坏 JSON 顶着备份的名字，比没备份更危险）。现在：失败只记日志、保留最近 45 份、
 * 备份后校验 JSON。
 */
async function backup(userId: string, date: string) {
  const result = await backupJournal(userId, date);
  if (!result.ok) {
    // 备份失败不抛、不 exit——记账主流程照常。冗余挂掉不该拖着生产死。
    console.error(`[backup] 失败但继续记账：${result.reason ?? "未知原因"}`);
    return;
  }
  const pruned = await pruneBackups(userId);
  if (pruned > 0) console.log(`[backup] 清理旧备份 ${pruned} 份（保留最近 ${BACKUP_KEEP_DAYS} 份）`);
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

// ── 冠军-挑战者：在跑的挑战者、各策略当前冠军参数 ─────────────
// 挑战者只改出场参数（持有天数/止损/目标价），选股名单和冠军完全一致——
// 这是「收益差异来自参数」这个归因能成立的前提。
const chalFile = await readChallengers();
const champions = await readChampions();
/** 每套策略已转正的挑战者参数（没有 = 用代码默认）。 */
const championParams = new Map<string, Challenger>();
for (const [style, id] of Object.entries(champions)) {
  const promoted = chalFile.list.find((item) => item.id === id);
  if (promoted) championParams.set(style, promoted);
}
let runningChallengers = chalFile.list.filter((item) => item.status === "running");

if (phase.date) {
  const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
  if (ownerBook) {
    // 按 style:variant 分桶：冠军和挑战者的判决必须各算各的，混在一起两边都判不准。
    // 分桶口径抽在 challenger.bucketReturns，UI 的「样本 x/30」进度和这里共用。
    const retsByBucket = bucketReturns(ownerBook.days);
    // 策略闸判的是冠军参数（挑战者样本不算冠军的成绩，反之亦然）。
    const retsByStyle = new Map<string, number[]>(ACTIVE_STYLES.map((style) => [style, retsByBucket.get(`${style}:champion`) ?? []]));
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
        // 冠军参数被策略闸停用时，自动回滚到默认参数——留档在 champion-log.jsonl。
        if (champions[style] && champions[style] !== "champion") {
          const from = champions[style];
          champions[style] = "champion";
          championParams.delete(style);
          await writeChampions(champions);
          const name = STYLES.find((item) => item.id === style)?.name ?? style;
          const reason = `策略闸停用，参数自动回滚（${from} → champion）`;
          await appendChampionLog({ at: Date.now(), style, from, to: "champion", reason });
          console.log(`champion-rollback ${style}: ${reason}`);
          notify(`${name} ${reason}`);
          void sendPushPlus("赤轨参数回滚", `${name}\n${reason}\n时间：${time}`);
        }
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

    // ── 挑战者判决：攒够样本自动转正/淘汰/停跑 ──────────────
    let chalChanged = false;
    for (const chal of chalFile.list) {
      if (chal.status !== "running") continue;
      const decision = judgeChallenger(
        retsByBucket.get(`${chal.style}:champion`) ?? [],
        retsByBucket.get(`${chal.style}:${chal.id}`) ?? [],
        tradingDaysSince(ownerBook.days, chal.since),
      );
      if (decision.action === "none") continue;
      chalChanged = true;
      chal.status = decision.action;
      const name = STYLES.find((item) => item.id === chal.style)?.name ?? chal.style;
      if (decision.action === "promote") {
        const from = champions[chal.style] ?? "champion";
        champions[chal.style] = chal.id;
        championParams.set(chal.style, chal);
        await writeChampions(champions);
        await appendChampionLog({ at: Date.now(), style: chal.style, from, to: chal.id, reason: decision.reason });
      }
      const label =
        decision.action === "promote"
          ? `参数转正：${chal.name} 成为 ${name} 的新冠军`
          : decision.action === "reject"
            ? `挑战者淘汰：${chal.name}`
            : `挑战者停跑：${chal.name}`;
      // VT3：判决落地时做参数邻域敏感度评估（悬崖/平台）——只标注不改判决，
      // promote/reject 由上面的 judgeChallenger 单独决定。评估失败不吞判决。
      let robustNote = "";
      try {
        const closedTrades = ownerBook.days
          .filter((day) => dayReliable(day))
          .flatMap((day) =>
            day.trades
              .filter((t) => t.variant === chal.id && t.exit != null && typeof t.entry === "number")
              .map((t) => ({ id: t.id, entryDate: day.date, entry: t.entry, stop: t.stop, target: t.target })),
          );
        const report = await robustnessReport({
          chal,
          verdict: decision.action,
          trades: closedTrades,
          barsOf: async (id) => (await kline(id)).bars,
        });
        if (report) {
          await writeRobustness(report);
          robustNote = `\n${report.note}`;
          console.log(`challenger-robust ${chal.id}: fragile=${report.fragile} (${report.simulated} simulated, ${report.skipped} skipped)`);
        }
      } catch (error) {
        console.error(`challenger-robust ${chal.id} 评估失败（不影响判决）:`, error);
      }
      console.log(`challenger ${chal.id} ${decision.action}: ${decision.reason}`);
      notify(`${label}：${decision.reason}${robustNote}`);
      void sendPushPlus("赤轨挑战者", `${label}\n${decision.reason}${robustNote}\n时间：${time}`);
    }
    if (chalChanged) {
      await writeChallengers(chalFile);
      runningChallengers = chalFile.list.filter((item) => item.status === "running");
    }
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
  // 腾讯源挂了就只能新浪顶着——新浪缺近 5/20/60 日涨幅和量比，在跑的两套策略
  // 出不了新票。这种降级不打断记账（结算照跑），但主人不在电脑前时只看到
  // 「今天没开仓」会误判成市场问题，所以每个交易日最多推一条微信说清原因。
  if (universe.source === "sina" && phase.date) {
    const stampPath = join(process.cwd(), "data", ".source-degrade-push.json");
    let notified = "";
    try {
      notified = (JSON.parse(await readFile(stampPath, "utf8")) as { date?: string }).date ?? "";
    } catch {
      // 没推过，正常
    }
    if (notified !== phase.date) {
      await writeFile(stampPath, JSON.stringify({ date: phase.date }));
      void sendPushPlus(
        "赤轨行情源降级",
        [`腾讯行情接口不可用，已切换新浪财经源。`, `新浪缺近 5/20/60 日涨幅和量比：放量突破、中期反转今天不出新票（不是选不出票）；持仓结算照常。`, `时间：${time}`].join("\n"),
      );
    }
  }
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

      // 信号留痕：观察名单前 10 只当天第一次出现就记，**没成交的也记**。
      // 不记的话账本里只有「现价打到买入价」那一批——所有绩效样本都自带
      // 「价格找上门」这个条件，选择偏差（价格跑飞 away / 涨停 limit 两种
      // 死法）没有分母可量。放在闸门判断之前：闸门拦不拦是风控的事，
      // 候选出现过是选股的事，两件事互不担保。
      appendSignals(
        phase.date!,
        style,
        list.map((row) => ({
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          score: row.score,
          buy: row.buy,
          hit: row.hit,
          block: row.block,
        })),
      );

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
        const promoted = championParams.get(style);
        const trade: Trade = {
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          // 已转正的挑战者参数在这里生效；没有就沿用名单给出的出场位。
          stop:
            promoted?.stopPct != null
              ? Math.round(row.buy * (1 - promoted.stopPct / 100) * 100) / 100
              : row.stop,
          target:
            promoted?.targetPct != null
              ? Math.round(row.buy * (1 + promoted.targetPct / 100) * 100) / 100
              : row.sell,
          style,
          // 持股天数查 strategies.ts 的 STYLE_HOLD（唯一定义处），不再在这里写三元字面量
          hold: promoted?.holdDays ?? holdOf(style),
          exit: null,
          exitDate: null,
        };
        additions.push(trade);
        held.push(trade);
        todayTrades.push(trade);
      }

      // 挑战者：同一份名单、不同的出场参数，每天限 1 只和冠军并行。
      // takeChallengerBuy 不占冠军名额（预登记：配额是自己的），但同样避开已持仓的票。
      for (const chal of runningChallengers) {
        if (chal.style !== style) continue;
        const ownToday = todayTrades.filter((t) => t.variant === chal.id).length;
        if (ownToday >= 1) {
          // 预登记铁律「每天限 1 只」：10-21 曾连跑 32 分钟买 3 只，必须留痕。
          console.log(`challenger-skip ${userId} ${phase.date} ${chal.id}：今天已买 ${ownToday} 只（预登记每日上限 1 只）`);
          continue;
        }
        const row = takeChallengerBuy(list, held, ownToday);
        if (!row) {
          // 别静默跳过：「挑战者今天为什么没买」事后全靠猜。逐行复算一遍
          // takeChallengerBuy 的过滤口径，把每行的落选原因打进日志，
          // 第二天就能从 serve.log 直接回答「是名单短（行情）还是开仓条件偏严」。
          const openIds = new Set(held.filter((t) => t.exit == null).map((t) => t.id));
          const seen = new Set<string>();
          let nHit = 0;
          const skip = { held: 0, limit: 0, dup: 0 };
          for (const r of list) {
            if (!r.hit) continue;
            nHit += 1;
            if (limitTag(r.quote) === "涨停") skip.limit += 1;
            else if (openIds.has(r.quote.id)) skip.held += 1;
            else if (seen.has(r.quote.id)) skip.dup += 1;
            else seen.add(r.quote.id);
          }
          console.log(
            `challenger-skip ${userId} ${phase.date} ${chal.id}：名单 ${list.length} 行，命中 ${nHit} 行——` +
              `已持仓挡 ${skip.held}、涨停挡 ${skip.limit}、重复挡 ${skip.dup}，剩 0 可买`,
          );
          continue;
        }
        const trade: Trade = {
          id: row.quote.id,
          code: row.quote.code,
          name: row.quote.name,
          entry: row.buy,
          stop:
            chal.stopPct != null
              ? Math.round(row.buy * (1 - chal.stopPct / 100) * 100) / 100
              : row.stop,
          target:
            chal.targetPct != null
              ? Math.round(row.buy * (1 + chal.targetPct / 100) * 100) / 100
              : row.sell,
          style,
          hold: chal.holdDays ?? holdOf(style),
          exit: null,
          exitDate: null,
          variant: chal.id,
        };
        additions.push(trade);
        held.push(trade);
        todayTrades.push(trade);
        // 单独记一行：挑战者建仓是 Welch 判决的样本来源，混在冠军那行 bought 里
        // 事后统计「挑战者今天买没买到」得靠数 variant，太绕。
        console.log(`bought-challenge ${userId} ${phase.date} ${chal.id} ${trade.name}`);
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
          return `${style}${trade.variant ? "·挑战" : ""} ${trade.name}`.trim();
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
          // 判定搬去 src/lib/market/settle.ts（有单测钉住）。原来这段内联在这儿，
          // 其中「还没到卖出日 vs 真卡住」的区分是踩过坑的：早先一律报「会一直挂着」，
          // 结果每次拿几十笔正常持仓刷一条假警报。现在 waiting 不算卡住。
          const verdict = settleOne({
            id: trade.id,
            name: trade.name,
            dayDate: day.date,
            entry: trade.entry,
            stop: trade.stop ?? null,
            target: trade.target ?? null,
            hold: trade.hold ?? HOLD_SESSIONS,
            bars: data.bars,
            rules,
          });
          if (verdict.kind !== "filled") {
            stillOpen = true;
            if (isStuck(verdict)) stuck.push(verdict.reason);
            continue;
          }
          trade.exit = verdict.price;
          trade.exitDate = verdict.date;
          trade.exitKind = "daily";
          changed = true;
          const key = `${userId}:${day.date}:${trade.id}:${verdict.reason}`;
          if (verdict.reason === "time" && !alerts.has(key)) {
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

// ── AI 自动进化：收盘后每天最多一轮（开关在 /ai 页，去重看 ai-log 里今天的 auto 记录）──
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const [prefs, config, aiLog] = await Promise.all([readAIPrefs(), readAIConfig(), readAILog()]);
    if (prefs.autoEvolve && config && !aiLog.some((e) => e.trigger === "auto" && e.at.slice(0, 10) === phase.date)) {
      // 熔断器：已断电的状态直接跳过（开关应该已被关掉，这里是双保险 + 审计）。
      const { readBreaker, nextBreakerState, writeBreaker, BREAKER_RULE } = await import(
        "../src/lib/market/evolve-breaker.ts"
      );
      const breaker = await readBreaker();
      if (breaker.trippedAt) {
        console.log(`${time} AI 自动进化已熔断（${breaker.trippedAt}），跳过。去 /ai 页重新打开开关恢复`);
      } else {
        // ① 观察：全局诊断先行——建议落 agent-diagnosis.json，本轮两层提议的
        // prompt 经 fetchDiagnosisHints 就能读到（observe → plan → act）。
        // 只诊断不行动；挂了记 ai-log，不连坐下面的提议层。
        try {
          const { runAgentDiagnosis } = await import("../src/lib/market/agent-loop.ts");
          const diag = await runAgentDiagnosis("auto");
          console.log(`${time} AI 全局诊断：${diag.ok ? diag.diagnosis?.summary ?? "ok" : `没跑成（${diag.error ?? "?"}）`}`);
        } catch (diagError) {
          console.error(`${time} AI 全局诊断失败（不影响提议）:`, diagError);
        }
        console.log(`${time} AI 自动进化开始`);
        const factor = await runFactorAILoop(
          { readRows: readFactorRuns, existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })) },
          "auto",
        );
        const strategy = await runStrategyAILoop("auto");
        console.log(
          `${time} AI 自动进化：因子层 ${factor.ok ? `提议 ${factor.proposed}` : `没跑成（${factor.error ?? "?"}）`} · 策略层 ${strategy.ok ? `提名 ${strategy.proposed}` : `没跑成（${strategy.error ?? "?"}）`}`,
        );
        const next = nextBreakerState(breaker, factor, strategy, new Date().toISOString());
        if (next !== breaker) await writeBreaker(next);
        if (next.trippedAt && !breaker.trippedAt) {
          // 断电动作：关开关（下次不再进这个分支）+ 推送叫人来看（静默断电等于没断）。
          const { writeAIPrefs } = await import("../src/lib/market/ai-prefs.ts");
          await writeAIPrefs({ autoEvolve: false });
          void sendPushPlus(
            "赤轨进化熔断",
            [`自动进化连续 ${BREAKER_RULE.maxConsecutiveErrors} 轮两层都失败，已自动断电。`, next.trippedReason, `去 /ai 页重新打开「自动进化」恢复。时间：${time}`].join("\n"),
          );
          console.error(`${time} AI 自动进化熔断：${next.trippedReason}`);
        }
        // 诊断已前移到提议之前（observe → plan → act），这里不再补跑。
      }
    }
  } catch (error) {
    console.error(`${time} AI 自动进化失败（不影响记账）:`, error);
  }
}

// ── 收盘后重建市值快照：每个交易日一次，排在判决回测之前 ─────────────────
// 为什么挂在记账进程里：这两份（cap.json 总市值 + floatcap.json 流通市值）以前
// 靠人手跑 build-caps.mjs，10-05 之后没人跑，cap.json 静默腐烂 19 天，数据审计
// A3 天天喊、登记表的补救命令还指向一个并不建 cap.json 的脚本——没人知道该跑
// 什么。现在封印后每个交易日重建一次（stamp 去重），且排在判决回测启动之前：
// 当晚 BT_FACTOR 回测用的就是当天收盘的市值，不带着旧快照出数。
// 同步跑不起进程：读一份 1.5MB 快照写两个文件，实测不到一秒；同步还能保证
// 「先于下面 auto-verdict」的顺序，异步起进程就得处理竞态。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const stampDir = join(process.cwd(), "data", "backtest");
    const capStamp = join(stampDir, `.caps-${phase.date}.stamp`);
    try {
      await access(capStamp);
    } catch {
      await mkdir(stampDir, { recursive: true });
      // stamp 写在成功之后：同步执行能知道成没成，失败了就下一分钟再试——
      // 先写 stamp 的话，一次抖动（比如快照还没落全）就等于当天不建了，
      // 那正是这次要修掉的「静默腐烂」形态。真持续性失败会每分钟记一条错，
      // 错得显眼比悄悄烂一天好。
      execFileSync(process.execPath, ["scripts/build-caps.mjs"], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 60_000,
      });
      await writeFile(capStamp, String(Date.now()));
      console.log(`${time} 市值快照已重建（${phase.date}：cap.json + floatcap.json）`);
    }
  } catch (error) {
    // 重建失败不挡记账、也不挡判决——今晚回测用旧快照照跑，审计 A3 会记下超龄。
    console.error(`${time} 市值快照重建失败（不影响记账，今晚判决回测用旧快照）:`, error);
  }
}

// ── 闭环最后一步：待验因子的判决回测 ─────────────────────────────
// AI 层只负责「提议进队列」，6 关判决要靠 BT_FACTOR=1 回测——以前这步只能人手跑，
// 自动进化断在半截：AI 每晚提的因子没人验。这里收盘封印后检查：队列里有活着的
// 因子且今天还没跑过判决，就异步起一轮回测（detached，不阻塞下一分钟记账；
// 回测只碰 data/backtest 和队列文件，和账本互不干扰）。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const { readQueue } = await import("../src/lib/market/factor-queue.ts");
    const { entries: queueEntries } = await readQueue();
    if (queueEntries.some((e) => e.status !== "tombstone")) {
      const stampDir = join(process.cwd(), "data", "backtest");
      const stamp = join(stampDir, `.auto-verdict-${phase.date}.stamp`);
      try {
        await access(stamp);
      } catch {
        await mkdir(stampDir, { recursive: true });
        await writeFile(stamp, String(Date.now()));
        const logFd = openSync(join(stampDir, "auto-verdict.log"), "a");
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--import", "./scripts/alias.mjs", "scripts/auto-verdict.ts"],
          { cwd: process.cwd(), detached: true, stdio: ["ignore", logFd, logFd] },
        );
        child.unref();
        console.log(`${time} 待验因子判决回测已异步启动（${phase.date}）`);
      }
    }
  } catch (error) {
    console.error(`${time} 判决回测触发失败（不影响记账）:`, error);
  }
}

// ── 每日复盘邮件：收盘封印后每个交易日一封（PRODUCT-PLAN §6 留存钩子）────────
// 三块内容：今日诊断摘要 / 挑战者战况 / 明日验证（昨天提的因子今天什么下场）。
// 钩子是「没看完的实验」不是行情——所以没有盈亏榜，只有实验进度。
// best-effort：没配 data/mail-config.json 静默跳过；配了发不出去只记日志，
// 不挡记账。stamp 写在成功之后——失败了下一分钟再试，邮件是钩子，
// 静默不发等于没有。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const mailStamp = join(process.cwd(), "data", `.daily-mail-${phase.date}.stamp`);
    try {
      await access(mailStamp);
    } catch {
      const { sendDailyMail } = await import("../src/lib/market/daily-mail.ts");
      const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
      const result = await sendDailyMail({ date: phase.date, days: ownerBook?.days ?? [] });
      if (result.sent) {
        await mkdir(join(process.cwd(), "data"), { recursive: true });
        await writeFile(mailStamp, String(Date.now()));
        console.log(`${time} 每日复盘邮件已发（${phase.date}）`);
      } else if (result.reason && result.reason !== "没配 mail-config.json") {
        // 没配是常态，静默；配了发不出去要显眼——每分钟一条直到发出去或人来看
        console.error(`${time} 每日复盘邮件发送失败（不影响记账，下分钟重试）: ${result.reason}`);
      }
    }
  } catch (error) {
    console.error(`${time} 每日复盘邮件失败（不影响记账）:`, error);
  }
}

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
