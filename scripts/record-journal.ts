/**
 * 这个文件是干什么的：
 * 纸面记账。交易时段里，现价碰到计划买入价才记一笔；之后碰到卖出价或止损价就结算。
 *
 * 你需要知道的：
 * 本机服务起来时会立刻跑一遍，之后大约每分钟再跑一遍（由 home-server.mjs 定时拉起）。
 * 只在交易日、行情对得上的时候才会按计划价记入新的买入。买入价写下后不再改。
 * 同一天卖出价和止损价都碰到，按止损结算；都没碰到，就等到第 8 个交易日收盘再结算。
 * 结果写在 data/books，并复制一份到用户目录下的 chiheng-backup。主人账号会收到 Mac 通知。
 * 收盘封印后还会每个交易日发一份每日复盘日报（诊断摘要/挑战者战况/明日验证），
 * 走 daily-digest.ts 分发：配了微信推送就推微信、配了邮箱就发信，都没配静默跳过。
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
import { OWNER_ID, listUserIds, readUserBook, readUserBookWithVersion, writeUserBook, type StoredBook } from "../src/lib/market/book-file.ts";
import { hardGate, nthClose, softGate, dayReliable, netReturn } from "../src/lib/market/journal-book.ts";
import { isStuck, settleOne } from "@/lib/market/settle";
import { evaluateGate, readStrategyGates, writeStrategyGates, readBacktestVerdicts, STRATEGY_GATE } from "../src/lib/market/strategy-gate.ts";
import {
  appendChampionLog,
  bucketReturns,
  judgeChallenger,
  loadChallengerRule,
  readChallengers,
  readChampions,
  tradingDaysSince,
  writeChallengers,
  writeChampions,
  type Challenger,
} from "../src/lib/market/challenger.ts";
import { appendChallengerVerdicts, attributeChallengerVerdict } from "../src/lib/market/loss-attrib.ts";
import { appendGateLog } from "../src/lib/market/gate-log.ts";
import { appendSignals } from "../src/lib/market/signal-log.ts";
import { readRules } from "../src/lib/market/rules-file.ts";
import { readPrefs } from "../src/lib/market/prefs-file.ts";
import { matchPrefs } from "../src/lib/market/prefs.ts";
import { loadIndices, loadKline, loadUniverse } from "../src/lib/market/quotes.functions.ts";
import { HOLD_SESSIONS, limitTag, planExit } from "../src/lib/market/model.ts";
import { ACTIVE_STYLES, DEEP_SCAN_TOP, deepScanChallengerBuy, holdOf, RETIRED_STYLES, STYLES, styleOf, takeBuys, takeChallengerBuy, watchList } from "../src/lib/market/strategies.ts";
import { loadAvoidIndex } from "../src/lib/market/lhb-avoid-index.server.ts";
import { loadRelay } from "../src/lib/market/sectors.ts";
import { formatClock, isTradingDay, sessionPhase, dayBarReady } from "../src/lib/market/session.ts";
import { intradayFill } from "../src/lib/market/intraday-fill.ts";
import { sendPushPlus } from "../src/lib/market/push.ts";
import { readAIPrefs } from "../src/lib/market/ai-prefs.ts";
import { readAILog } from "../src/lib/market/ai-log.ts";
import { readFactorRuns } from "../src/lib/market/factor-runs-file.ts";
import { readAIConfig, runFactorAILoop } from "../src/lib/market/factor-queue.ts";
import { runStrategyAILoop } from "../src/lib/market/strategy-ai.ts";
import { runGenomeLoop } from "../src/lib/market/strategy-genome.ts";
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
   * 退出原因（settle 的 verdict.reason）：stop 止损 / target 到价 / time 到期。
   * 2026-10-28 起落盘；老账没有这个字段 → 失败归因标「原因未定」，不反推。
   */
  exitReason?: "stop" | "target" | "time";
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
  /**
   * 深扫样本标记（DECISIONS #4 方案 D）：主名单 top-10 全被已持仓挡死时从 11~20
   * 名买的。分数低于主名单，判决落地时必须注明含几笔——不分层等于把低分样本
   * 悄悄混进主样本，参数归因就脏了。
   */
  deepScan?: boolean;
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

/**
 * 微信推送（best-effort，但必须**等它真的发完**）。
 *
 * 2026-11-08 全量体检：这里原先 10 处写成 `void sendPushPlus(...)`，而 record-journal
 * 是每分钟新起的短命进程——fire-and-forget 的 HTTP 请求大概率在进程退出前没发出去，
 * 推送静默丢失；`push.ts` 头部注释记的「推没推出去是事实，不许猜」正是这个坑。
 * 更糟的是两处去重 stamp 在发送前/无条件写，失败也标成已推，当天再不重试。
 *
 * 所以：一律 await、返回是否真发出、绝不因为推送异常把记账带崩。
 */
const pendingPushes: Promise<boolean>[] = [];
function pushBestEffort(title: string, content: string): Promise<boolean> {
  const p = sendPushPlus(title, content)
    .then((sent) => {
      if (!sent) console.error(`${time} 推送未发出（未配置或接口失败）：${title}`);
      return sent;
    })
    .catch((e) => {
      console.error(`${time} 推送异常（不影响记账）：${title}`, e);
      return false;
    });
  pendingPushes.push(p);
  return p;
}
/** 进程退出前把所有已排队的推送等完，避免短命进程截断请求。 */
async function flushPushes(): Promise<void> {
  await Promise.allSettled(pendingPushes);
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
// 判决规则从数据文件读（代码默认 ← data/challenger-rule.json 覆盖），不再写死在代码。
// 每轮只读一次：优化循环改了规则文件，下一轮记账就用到新值。
const challengerRule = await loadChallengerRule();

if (phase.date) {
  const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
  if (ownerBook) {
    // 按 style:variant 分桶：冠军和挑战者的判决必须各算各的，混在一起两边都判不准。
    // 分桶口径抽在 challenger.bucketReturns，UI 的「样本 x/30」进度和这里共用。
    const retsByBucket = bucketReturns(ownerBook.days);
    // 策略闸判的是冠军参数（挑战者样本不算冠军的成绩，反之亦然）。
    const retsByStyle = new Map<string, number[]>(ACTIVE_STYLES.map((style) => [style, retsByBucket.get(`${style}:champion`) ?? []]));
    // 平仓日（和 rets 对齐）——聚类稳健 t 用。20 笔可能只落在 2 天，raw t 把 2 天
    // 当 20 个独立观测是假的；天数不够时 evaluateGate 会返回 none，交给回测判决。
    const datesByStyle = new Map<string, string[]>();
    for (const style of ACTIVE_STYLES) {
      const dates: string[] = [];
      for (const day of ownerBook.days) {
        if (!dayReliable(day)) continue;
        for (const trade of day.trades) {
          if (trade.exit == null || typeof trade.entry !== "number") continue;
          if (styleOf(trade) !== style) continue;
          if (trade.variant && trade.variant !== "champion") continue;
          if (netReturn(trade.entry, trade.exit) == null) continue;
          dates.push(trade.exitDate ?? day.date);
        }
      }
      datesByStyle.set(style, dates);
    }
    let gatesChanged = false;
    for (const style of ACTIVE_STYLES) {
      const decision = evaluateGate({
        rets: retsByStyle.get(style) ?? [],
        dates: datesByStyle.get(style) ?? [],
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
          await pushBestEffort("赤轨参数回滚", `${name}\n${reason}\n时间：${time}`);
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
      await pushBestEffort("赤轨策略闸门", `${name} ${label}\n${decision.reason}\n时间：${time}`);
    }
    // ── 回测判决：全池回测的信噪比 ≤ −2 也判「这套失效」──
    // 线上样本太少（13 天、最近 20 笔落在 2 天）测不出慢亏，回测 250 天才有统计功效。
    // live 闸门看「真钱近期」，回测判决看「策略本身有没有 alpha」，两者任一判负都停。
    const backtestVerdicts = await readBacktestVerdicts();
    for (const style of ACTIVE_STYLES) {
      if (gateDisabled.has(style)) continue; // 已停用，别重复判
      const v = backtestVerdicts[style];
      if (!v || typeof v.clusterT !== "number") continue;
      if (v.clusterT > STRATEGY_GATE.disableT) continue;
      const reason = `全池回测信噪比=${v.clusterT.toFixed(2)} ≤ ${STRATEGY_GATE.disableT}（${v.n} 笔 / ${v.days} 天），策略无 alpha`;
      strategyGates[style] = { state: "disabled", since: phase.date, cooldownDays: STRATEGY_GATE.cooldownDays, strikes: 1, reason };
      gatesChanged = true;
      gateDisabled.add(style);
      gateParoled.delete(style);
      if (champions[style] && champions[style] !== "champion") {
        const from = champions[style];
        champions[style] = "champion";
        championParams.delete(style);
        await writeChampions(champions);
        const name = STYLES.find((item) => item.id === style)?.name ?? style;
        const rollbackReason = `回测判决停用，参数自动回滚（${from} → champion）`;
        await appendChampionLog({ at: Date.now(), style, from, to: "champion", reason: rollbackReason });
        console.log(`champion-rollback ${style}: ${rollbackReason}`);
        notify(`${name} ${rollbackReason}`);
        await pushBestEffort("赤轨参数回滚", `${name}\n${rollbackReason}\n时间：${time}`);
      }
      const name = STYLES.find((item) => item.id === style)?.name ?? style;
      console.log(`strategy-gate ${style} disable(回测): ${reason}`);
      notify(`${name} 已自动停用（回测判决）：${reason}`);
      await pushBestEffort("赤轨策略闸门", `${name} 已自动停用（回测判决）\n${reason}\n时间：${time}`);
    }
    if (gatesChanged) await writeStrategyGates(strategyGates);

    // ── 挑战者判决：攒够样本自动转正/淘汰/停跑 ──────────────
    let chalChanged = false;
    for (const chal of chalFile.list) {
      if (chal.status !== "running") continue;
      const champRets = retsByBucket.get(`${chal.style}:champion`) ?? [];
      const chalRets = retsByBucket.get(`${chal.style}:${chal.id}`) ?? [];
      const decision = judgeChallenger(
        champRets,
        chalRets,
        tradingDaysSince(ownerBook.days, chal.since),
        challengerRule,
      );
      if (decision.action === "none") continue;
      chalChanged = true;
      // 判决动作 → 挑战者状态是两套词表：action 是 promote/reject/inconclusive，
      // 状态是 promoted/rejected/inconclusive。直接赋值会把 "reject" 落进账
      // （2026-10-28 实际发生过，/factors 挑战者面板按状态查表直接崩）。
      chal.status =
        decision.action === "promote" ? "promoted" : decision.action === "reject" ? "rejected" : "inconclusive";
      // 归因留档：把判决 + 它为什么发生记进失败档案（append-only），优化循环读它找根因。
      try {
        const verdict = attributeChallengerVerdict({
          chal,
          action: decision.action,
          reason: decision.reason,
          champRets,
          chalRets,
          day: phase.date,
        });
        await appendChallengerVerdicts([verdict]);
      } catch (e) {
        console.error(`challenger-verdict ${chal.id} 留档失败（不影响判决）:`, e);
      }
      const name = STYLES.find((item) => item.id === chal.style)?.name ?? chal.style;
      if (decision.action === "promote") {
        const from = champions[chal.style] ?? "champion";
        champions[chal.style] = chal.id;
        championParams.set(chal.style, chal);
        await writeChampions(champions);
        await appendChampionLog({ at: Date.now(), style: chal.style, from, to: chal.id, reason: decision.reason });
      }
      // 分层留痕（DECISIONS #4 方案 D）：深扫样本混在主样本里攒判决，判决落地时
      // 必须说明含几笔，事后才能按层拆开复核归因。
      const deepCount = ownerBook.days
        .flatMap((day) => day.trades)
        .filter((t) => t.variant === chal.id && t.exit != null && t.deepScan === true).length;
      const deepNote = deepCount > 0 ? `（样本含深扫 ${deepCount} 笔）` : "";
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
      console.log(`challenger ${chal.id} ${decision.action}: ${decision.reason}${deepNote}`);
      notify(`${label}：${decision.reason}${deepNote}${robustNote}`);
      await pushBestEffort("赤轨挑战者", `${label}\n${decision.reason}${deepNote}${robustNote}\n时间：${time}`);
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
      // 只在真发出去时写 stamp：失败/没配通道都保持「未推」，下分钟重试。
      // 原先是先写 stamp 再 `void` 推送 —— 发失败也标成已推，当天永久丢失这条提醒。
      const sent = await pushBestEffort(
        "赤轨行情源降级",
        [`腾讯行情接口不可用，已切换新浪财经源。`, `新浪缺近 5/20/60 日涨幅和量比：现役两套里放量突破今天不出新票（不是选不出票）；低估值不依赖这些字段照常；持仓结算不受影响。`, `时间：${time}`].join("\n"),
      );
      if (sent) await writeFile(stampPath, JSON.stringify({ date: phase.date }));
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
  // 龙虎榜净买（游资/营业部驱动）回避过滤器（实盘可用，需显式开启）：建索引一次，之后零 IO。
  // 索引为空时 shouldAvoid 安全默认返回 false，不会静默全删。
  if (process.env.LIVE_AVOID_LHB === "1") {
    await loadAvoidIndex();
    console.log(`[avoid] 龙虎榜净买（游资/营业部驱动）回避索引已加载（席位口径 ${process.env.LHB_SEATS ?? "noninst"}，窗口 ${Number(process.env.LIVE_AVOID_WIN ?? 80)} 天）`);
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

async function runBook(userId: string, book: Book, expectedVersion: string | null): Promise<boolean> {
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
          : watchList(universe.quotes, style, rules, (quote) => matchPrefs(quote, prefs), undefined, phase.date);
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

    }

    // ── 挑战者买入：独立于 ACTIVE_STYLES 循环 ─────────────────────────
    // 挑战者的目的是「找到能接班的策略」。以前它挂在 `for (const style of ACTIVE_STYLES)`
    // 里面、且要求 `chal.style === style` 才买——母策略一停（breakout 被闸）挑战者也跟着
    // 饿死，永远攒不出样本、找不到替代品。现在改成挑战者用自己的 style 生成名单，
    // 每天限 1 只。全局 hard 闸（连亏停手）仍然拦它；母策略被闸（无 alpha）的挑战者不孵。
    if (hard.ok) {
      for (const chal of runningChallengers) {
        // 已淘汰家族的挑战者不买（2026-11-09 用户拍板，双保险）：status 已置
        // inconclusive，这里再挡一道防手工改回 JSON 复活——母家族都判了淘汰，
        // 变体判赢也没有现役席位（rebound 还被白皮书明文封禁）。名单唯一出处
        // strategies.ts 的 RETIRED_STYLES，和 AI 提名闸同一份。
        if ((RETIRED_STYLES as string[]).includes(chal.style)) continue;
        if (gateDisabled.has(chal.style)) continue;
        const ownToday = todayTrades.filter((t) => t.variant === chal.id).length;
        if (ownToday >= 1) {
          // 预登记铁律「每天限 1 只」：10-21 曾连跑 32 分钟买 3 只，必须留痕。
          console.log(`challenger-skip ${userId} ${phase.date} ${chal.id}：今天已买 ${ownToday} 只（预登记每日上限 1 只）`);
          continue;
        }
        const chalList =
          chal.style === "relay"
            ? relay.filter((row) => matchPrefs(row.quote, prefs))
            : watchList(universe.quotes, chal.style, rules, (quote) => matchPrefs(quote, prefs), undefined, phase.date);
        let row = takeChallengerBuy(chalList, held, ownToday);
        let deepScan = false;
        if (!row) {
          // 别静默跳过：把每行的落选原因打进日志，第二天能从 serve.log 直接回答
          // 「是名单短（行情）还是开仓条件偏严」。
          const openIds = new Set(held.filter((t) => t.exit == null).map((t) => t.id));
          const seen = new Set<string>();
          let nHit = 0;
          const skip = { held: 0, limit: 0, dup: 0 };
          for (const r of chalList) {
            if (!r.hit) continue;
            nHit += 1;
            if (limitTag(r.quote) === "涨停") skip.limit += 1;
            else if (openIds.has(r.quote.id)) skip.held += 1;
            else if (seen.has(r.quote.id)) skip.dup += 1;
            else seen.add(r.quote.id);
          }
          // 深扫只对「名单饱和」这一种饿法生效。涨停挡说明行情封板，不扫；
          // relay 的名单机制不同（14:30 冻结），也不扫。
          if (nHit > 0 && skip.held === nHit && chal.style !== "relay") {
            const deepList = watchList(universe.quotes, chal.style, rules, (quote) => matchPrefs(quote, prefs), DEEP_SCAN_TOP, phase.date);
            const deepRow = deepScanChallengerBuy(deepList, held);
            if (deepRow) {
              row = deepRow;
              deepScan = true;
              console.log(
                `challenger-deepscan ${userId} ${phase.date} ${chal.id} ${deepRow.quote.name}` +
                  `（主名单 ${nHit} 行全被已持仓挡死，深扫第 ${deepList.indexOf(deepRow) + 1} 名）`,
              );
            }
          }
          if (!row) {
            console.log(
              `challenger-skip ${userId} ${phase.date} ${chal.id}：名单 ${chalList.length} 行，命中 ${nHit} 行——` +
                `已持仓挡 ${skip.held}、涨停挡 ${skip.limit}、重复挡 ${skip.dup}，剩 0 可买（含深扫）`,
            );
            continue;
          }
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
          style: chal.style,
          hold: chal.holdDays ?? holdOf(chal.style),
          exit: null,
          exitDate: null,
          variant: chal.id,
          ...(deepScan ? { deepScan: true } : {}),
        };
        additions.push(trade);
        held.push(trade);
        todayTrades.push(trade);
        // 单独记一行：挑战者建仓是 Welch 判决的样本来源，混在冠军那行 bought 里
        // 事后统计「挑战者今天买没买到」得靠数 variant，太绕。
        console.log(`bought-challenge ${userId} ${phase.date} ${chal.id} ${trade.name}${deepScan ? "（深扫）" : ""}`);
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
      // 买入成交 → 微信推送（2026-11-09 用户反馈：卖出有提醒、买入一声不吭，
      // 每次都不知道买了什么、买在什么价。一个记账周期的成交合成一条，别刷屏）。
      const buyLines = additions.map((trade) => {
        const style = STYLES.find((item) => item.id === trade.style)?.name ?? trade.style ?? "";
        const plan = trade.stop != null && trade.target != null ? ` · 止损 ${trade.stop} / 目标 ${trade.target}` : "";
        const hold = trade.hold != null ? ` · 持 ${trade.hold} 天` : "";
        return `${style}${trade.variant ? "·挑战" : ""} ${trade.name} ${trade.code} @ ${trade.entry}${plan}${hold}`;
      });
      await pushBestEffort("赤轨买入提醒", [...buyLines, `记账时间：${time} · 交易日 ${phase.date}`].join("\n"));
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
      // T+1：今天买的今天卖不掉，所以买入日 >= 今天的一律跳过。
      // 这行别删——它是盘中路径唯一挡住「当天买当天卖」的东西，
      // 删了之后 exitDate 会等于买入日，账上凭空多出一笔当日往返。
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
        if (fill.reason === "stop" || fill.reason === "target" || fill.reason === "time") {
          trade.exitReason = fill.reason;
        }
        changed = true;
      }
    }
    if (speak) {
      notifyNames("到止损价", stops);
      notifyNames("到卖出价", targets);
      // PushPlus 微信推送：和 Mac 通知同一份名单（stops/targets 只在新预警出现时才有内容）。
      if (stops.length > 0 || targets.length > 0) {
        await pushBestEffort(
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
    // 只算一次：这一轮里今天的日线定没定型，整批交易用同一个判断。
    const todayClosed = dayBarReady();
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
            // A 股 15:00 收盘才产生收盘价，行情接口还要几分钟才把今天这根写定型。
            // 在那之前把今天的 K 线剔出判定（settle.ts 里做），否则到期结算会拿
            // 盘中现价冒充收盘价——2026-10-28 查账发现 10 笔这么写歪过。
            // 盘中真跌破止损的仓，上面 intraday 那条线每分钟已经结掉了，轮不到这里。
            today: phase.date,
            todayClosed,
            rules,
          });
          if (verdict.kind !== "filled") {
            stillOpen = true;
            if (isStuck(verdict)) stuck.push(verdict.reason);
            continue;
          }
          // T+1 硬闸：写账之前最后一道。今天买的票今天卖不掉，任何路径（换撮合、
          // 换数据源、以后有人改 exitFill）想当天成交都不许落账。
          // 单测 trading-rules.test.ts 钉的是函数行为，这道闸钉的是"真的没写进账"。
          if (!(verdict.date > day.date)) {
            stillOpen = true;
            console.log(
              `${time} 拒绝落账（违反 T+1）：${trade.name} 买入 ${day.date}、判定成交 ${verdict.date}，按未平仓处理`,
            );
            continue;
          }
          trade.exit = verdict.price;
          trade.exitDate = verdict.date;
          trade.exitKind = "daily";
          // 落盘退出原因：失败归因按 stop/gap/time 分类靠它，不落就只能靠猜。
          if (verdict.reason === "stop" || verdict.reason === "target" || verdict.reason === "time") {
            trade.exitReason = verdict.reason;
          }
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
      if (due.length > 0) await pushBestEffort("赤轨预警", [`到期该卖：${due.join("、")}`, `时间：${time}`].join("\n"));
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

  // ── 每日对账快照（P2 报告 §5-④）──────────────────────────────────
  // 收盘后落一份「当天 /today 信号 vs 账本真实成交」的快照，供以后扩样本。
  // 纯落盘：不写账本、不改建仓、失败只警告（和 gate-log 同款纪律）。
  if (phase.sealed && phase.date && isTradingDay(phase.date)) {
    // stamp 去重：快照一天一份就够（收盘后账本基本定型）。没 stamp 的话记账进程
    // 每分钟重读 reviewed.json + 重写 10KB 文件，一天 240 次纯浪费（2026-11-14 全仓过一遍发现）。
    try {
      const recStamp = join(process.cwd(), "data", `.reconcile-snap-${phase.date}.stamp`);
      let reconciled = false;
      try {
        await access(recStamp);
        reconciled = true;
      } catch {
        /* 今天还没落 */
      }
      if (reconciled) {
        /* 已落，跳过 */
      } else {
      const { writeReconcileSnapshot } = await import("../src/lib/market/reconcile-snapshot.ts");
      let signals: Parameters<typeof writeReconcileSnapshot>[0]["signals"] = null;
      try {
        const raw = JSON.parse(await readFile(join(process.cwd(), "data", "signals", "reviewed.json"), "utf8")) as {
          date?: string;
          signals?: { code: string; name: string; leg?: "long" | "short"; verdict?: "ok" | "warn" | "skip"; order?: { price?: number }; fill?: { status?: "filled" | "missed" | "pending" } }[];
        };
        // 只认当天那份：备份/残留的隔日 reviewed.json 不能冒充今天的名单。
        if (raw.date === phase.date && Array.isArray(raw.signals)) {
          signals = raw.signals.map((s) => ({
            code: s.code, name: s.name, leg: s.leg,
            orderPrice: s.order?.price ?? null,
            fillStatus: s.fill?.status,
            verdict: s.verdict,
          }));
        }
      } catch {
        /* 读不到就落 missing，让快照自己说明 */
      }
      const out = writeReconcileSnapshot({
        date: phase.date,
        signals,
        days: days.map((d) => ({
          date: d.date,
          trades: d.trades.map((t) => ({
            code: t.code, name: t.name, entry: t.entry,
            style: t.style, variant: t.variant, deepScan: t.deepScan, exit: t.exit,
          })),
        })),
      });
      if (!out.path) console.warn(`[reconcile] ${phase.date} 快照没落：${out.reason}`);
      else await writeFile(recStamp, String(Date.now()));
      } // else reconciled
    } catch (err) {
      console.warn(`[reconcile] 快照写入异常：${(err as Error).message}`);
    }
  }

  // ── 日终汇总推送：收盘后当天第一次跑时推一条当日账本流水 ──────────
  // 板块逻辑梳理（2026-11-05）补的通知缺口：闸门/判决/预警都有推送，唯独
  // 「今天到底结算成什么样」没有——人不在 Mac 前时只能开盘后自己翻账本。
  // 和净值沉淀同一时机（sealed + 交易日），stamp 去重一天只推一次。
  if (phase.sealed && phase.date && isTradingDay(phase.date)) {
    const stampPath = join("data", `daily-digest-${userId}.json`);
    let digested = "";
    try {
      digested = (JSON.parse(await readFile(stampPath, "utf8")) as { date?: string }).date ?? "";
    } catch {
      /* 没跑过 */
    }
    if (digested !== phase.date) {
      const bought = days.find((day) => day.date === phase.date)?.trades ?? [];
      const soldToday = days.flatMap((day) => day.trades).filter((t) => t.exitDate === phase.date && t.exit != null);
      const openNow = days.flatMap((day) => day.trades).filter((t) => t.exit == null);
      const realized = soldToday.reduce((sum, t) => sum + (t.exit! - t.entry) / t.entry, 0);
      const wins = soldToday.filter((t) => (t.exit! - t.entry) > 0).length;
      const byStyle = new Map<string, number>();
      for (const t of bought) {
        const key = t.style ?? "other";
        byStyle.set(key, (byStyle.get(key) ?? 0) + 1);
      }
      const styleText = [...byStyle.entries()]
        .map(([style, n]) => `${STYLES.find((item) => item.id === style)?.name ?? style} ${n}`)
        .join("、");
      const sent = await pushBestEffort(
        "赤轨日终",
        [
          `今日买入 ${bought.length} 笔${bought.length > 0 ? `（${styleText}）` : ""}，卖出 ${soldToday.length} 笔${soldToday.length > 0 ? `（${wins} 赚 ${soldToday.length - wins} 亏）` : ""}。`,
          soldToday.length > 0 ? `已实现合计 ${(realized * 100).toFixed(2)}%（逐笔收益率相加）。` : null,
          `当前持仓 ${openNow.length} 笔，未结风险挂在策略追踪页。`,
          `时间：${time}`,
        ]
          .filter((line): line is string => line != null)
          .join("\n"),
      );
      // 真发出去才写 stamp；没配通道或发送失败都保持「未推」，下分钟重试（和日报口径一致）。
      if (sent) await writeFile(stampPath, JSON.stringify({ date: phase.date }));
    }
  }

  if (changed) await writeUserBook(userId, { joinedAt: book.joinedAt, days, nextSettleAt }, { expectedVersion });
  return changed;
}

const ids = await listUserIds();
let any = false;
for (const userId of ids) {
  // 读时记下内容版本，写回时校验：这一轮拉行情/跑闸门可能几十秒，
  // 期间网页手动合并或 backfill 若改过账本，宁可跳过这一轮也不整本覆盖。
  const { book, version } = await readUserBookWithVersion<Day>(userId);
  if (await runBook(userId, book, version)) any = true;
}
if (!any) console.log(`${time} ${phase.label} no change`);
if (alertsChanged) await writeAlerts(alerts);

// ── AI 自动进化：收盘后每天最多一轮，失败的层当天按 AUTO_RETRY 间隔补跑
//    （开关在 /ai 页；去重粒度是「层」不是「天」，判据见 evolve-breaker.autoLayerDue）──
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const [prefs, config, aiLog] = await Promise.all([readAIPrefs(), readAIConfig(), readAILog()]);
    // 去重粒度是「层」不是「天」：一天一轮的口径不变，但失败的轮次不算跑过——
    // 10-20 / 10-22 各有一次超时让整个交易日白跑（ai-log 里 ok:false 也占掉了
    // 「今天已跑」的名额）。现在按 autoLayerDue 每层独立判：今天这层成功过就不跑，
    // 失败则按 AUTO_RETRY 的间隔/上限当天补跑。
    const todayAuto = aiLog.filter((e) => e.trigger === "auto" && e.at.slice(0, 10) === phase.date);
    const { autoLayerDue } = await import("../src/lib/market/evolve-breaker.ts");
    const dueFactor = autoLayerDue(todayAuto, "factor");
    const dueStrategy = autoLayerDue(todayAuto, "strategy");
    // 基因组层（2026-11-05 新增）：产出全新/更新的策略 spec——「失败 → 新策略」那一层。
    // 同样按层独立判「今天该不该跑」，失败也按 AUTO_RETRY 补跑。
    const dueGenome = autoLayerDue(todayAuto, "genome");
    // 诊断（observe 层）跟着第一轮跑：任一层要跑且今天还没诊断过才诊断。
    const dueDiagnosis = (dueFactor || dueStrategy || dueGenome) && !todayAuto.some((e) => e.layer === "agent");
    // 小机总开关（2026-11-14）：off = 自动进化也停。用户口径「AI 是一个整体」——
    // 一个总闸断全部（手动派活/定时任务/工单/反思链条），不留双开关各管各的口子。
    let masterOn = true;
    try {
      const { readMasterSwitch } = await import("../src/lib/market/agent-jobs.ts");
      masterOn = (await readMasterSwitch()).enabled;
    } catch (masterErr) {
      // 读不到开关（文件坏了/模块挂了）按「开」算——反思链条不该被一个辅助文件炸掉。
      console.error(`${time} 读小机总开关失败（按开处理）:`, masterErr);
    }
    if (!masterOn) {
      console.log(`${time} 小机总开关关闭，自动进化本轮跳过（不想跑反思链条也去 /ai 关「自动进化」）`);
    }
    if (prefs.autoEvolve && masterOn && config && (dueFactor || dueStrategy || dueGenome)) {
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
        if (dueDiagnosis) {
          try {
            const { runAgentDiagnosis } = await import("../src/lib/market/agent-loop.ts");
            const diag = await runAgentDiagnosis("auto");
            console.log(`${time} AI 全局诊断：${diag.ok ? diag.diagnosis?.summary ?? "ok" : `没跑成（${diag.error ?? "?"}）`}`);
          } catch (diagError) {
            console.error(`${time} AI 全局诊断失败（不影响提议）:`, diagError);
          }
        }
        const retrying = [dueFactor && "因子层", dueStrategy && "策略层", dueGenome && "基因组层"].filter(Boolean).join("、");
        console.log(`${time} AI 自动进化开始${retrying === "因子层、策略层、基因组层" ? "" : `（补跑：${retrying}）`}`);
        // 没到点的那层不跑，交给熔断器的 outcome 记 ok——今天这层已有产出，
        // 不能让补跑的另一层把整天算成「双败」。
        const skipOutcome = { ok: true, proposed: 0, rejected: 0, rejectReasons: [] };
        const factor = dueFactor
          ? await runFactorAILoop(
              { readRows: readFactorRuns, existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })) },
              "auto",
            )
          : skipOutcome;
        const strategy = dueStrategy ? await runStrategyAILoop("auto") : skipOutcome;
        // 基因组层：失败只记它自己的账，不进熔断器的「双败」判定——
        // 熔断是给「因子层+策略层」这两条老通道设的，基因组层挂了不该把整个进化断电。
        const genome = dueGenome ? await runGenomeLoop("auto") : skipOutcome;
        console.log(
          `${time} AI 自动进化：因子层 ${factor.ok ? `提议 ${factor.proposed}` : `没跑成（${factor.error ?? "?"}）`} · 策略层 ${strategy.ok ? `提名 ${strategy.proposed}` : `没跑成（${strategy.error ?? "?"}）`} · 基因组层 ${genome.ok ? `提议 ${genome.proposed} 套策略` : `没跑成（${genome.error ?? "?"}）`}`,
        );
        const next = nextBreakerState(breaker, factor, strategy, new Date().toISOString());
        if (next !== breaker) await writeBreaker(next);
        if (next.trippedAt && !breaker.trippedAt) {
          // 断电动作：关开关（下次不再进这个分支）+ 推送叫人来看（静默断电等于没断）。
          const { writeAIPrefs } = await import("../src/lib/market/ai-prefs.ts");
          await writeAIPrefs({ autoEvolve: false });
          await pushBestEffort(
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
    // 待判的东西：队列里有活着的因子，**或者**基因组里有待判的策略候选。
    // 两个都要看——只看因子队列的话，队列清空那天策略判决会跟着一起静默停掉
    // （2026-11-05 补：策略/基因组判决也挂在这条路上）。
    const { readGenome } = await import("../src/lib/market/strategy-genome.ts");
    const genomeCandidates = (await readGenome()).list;
    const hasPendingFactor = queueEntries.some((e) => e.status !== "tombstone");
    const hasPendingGenome = genomeCandidates.some((c) => c.status === "proposed" || c.status === "testing");
    if (hasPendingFactor || hasPendingGenome) {
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
        console.log(
          `${time} 判决回测已异步启动（${phase.date}）` +
            `——待验因子 ${hasPendingFactor ? "有" : "无"}，待判策略 ${hasPendingGenome ? "有" : "无"}`,
        );
      }
    }
  } catch (error) {
    console.error(`${time} 判决回测触发失败（不影响记账）:`, error);
  }
}

// ── 每日复盘日报：收盘封印后每个交易日一份（PRODUCT-PLAN §6 留存钩子）────────
// 三块内容：今日诊断摘要 / 挑战者战况 / 明日验证。钩子是「没看完的实验」不是行情。
// 通道：邮件（可选，需 SMTP 授权码）和/或 PushPlus 微信推送（可选，用已有 token）。
// 配了哪个走哪个，都没配静默跳过；任一通道真成功才写 stamp，全失败下分钟重试。
// best-effort：绝不能因为它把记账进程带崩。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    // 文件名沿用 .daily-mail-*.stamp：语义变了但历史 stamp 得继续认，否则会重复发。
    const digestStamp = join(process.cwd(), "data", `.daily-mail-${phase.date}.stamp`);
    try {
      await access(digestStamp);
    } catch {
      const date = phase.date;
      const { sendDailyDigest } = await import("../src/lib/market/daily-digest.ts");
      const { writeDigestStatus } = await import("../src/lib/market/digest-status.ts");
      // 状态写盘是纯可观测性：它自己失败也不能影响发送或记账。
      const noteDelivery = async (status: "sent" | "failed", channels: ("mail" | "wechat")[], reason?: string) => {
        try {
          await writeDigestStatus({ at: new Date().toISOString(), date, status, channels, reason });
        } catch (e) {
          console.error(`${time} 日报状态写盘失败（不影响发送）:`, e);
        }
      };
      const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
      const result = await sendDailyDigest({ date, days: ownerBook?.days ?? [] });
      if (result.sent) {
        await mkdir(join(process.cwd(), "data"), { recursive: true });
        await writeFile(digestStamp, String(Date.now()));
        console.log(`${time} 每日复盘日报已发（${date}）通道：${result.channels.join("+")}`);
        await noteDelivery("sent", result.channels);
      } else if (result.status === "failed") {
        // 配了却发不出去要显眼——每分钟一条直到发出去或人来看
        console.error(`${time} 每日复盘日报发送失败（不影响记账，下分钟重试）: ${result.reason ?? ""}`);
        await noteDelivery("failed", [], result.reason);
      }
      // status === "none" 是没配通道的常态：静默，也不写状态（保持「还没发过」）
    }
  } catch (error) {
    console.error(`${time} 每日复盘日报失败（不影响记账）:`, error);
  }
}

// ── 清理已淘汰家族的僵尸挑战者（2026-11-14）──────────────────────
// 实测：14 个挑战者里 8 个卡在 inconclusive，其中 6 个属于已淘汰家族
// （rebound/early/trend/relay 11-09 起不再建仓）。它们永远攒不够 minTrades，
// 判也判不出、退也退不掉，永久躺在名单里让页面显示一堆「停跑·未分胜负」。
// 清理只标终态 + 写明原因，**不删记录**（历史事实要留着）。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const { readChallengers, writeChallengers, retireDeadFamilyChallengers } = await import(
      "../src/lib/market/challenger.ts"
    );
    const file = await readChallengers();
    const { list: next, retired } = retireDeadFamilyChallengers(file.list, RETIRED_STYLES, phase.date);
    if (retired.length > 0) {
      await writeChallengers({ list: next });
      console.log(`${time} 清理僵尸挑战者 ${retired.length} 个（所属策略已淘汰）：${retired.map((c) => c.id).join("、")}`);
    }
  } catch (error) {
    console.error(`${time} 清理僵尸挑战者失败（不影响记账）:`, error);
  }
}

// ── 规则改动效果回验（2026-11-14，反思闭环最后一环）────────────────
// 优化器会依据诊断自动改 challenger-rule，每次改动写进 rule-change-log.jsonl，
// 但**从没回头验证过**——earlyRejectDays 在 10-30~11-11 被来回摆 6 次
// （15→3→5→10→12→20→30），earlyRejectGap 摆 4 次，全是盲调。
// 这里每天收盘后对「已过观察期」的改动做一次前后窗口对比，落
// data/rule-change-effects.jsonl：有效→保留，无效→给回滚建议（人不拍板不执行）。
// 只读账本 + 只写回验报告，不改任何规则——回滚仍需人拍板。
if (phase.sealed && phase.date && isTradingDay(phase.date)) {
  try {
    const stamp = join(process.cwd(), "data", `rule-effect-${phase.date}.stamp`);
    let done = false;
    try {
      await access(stamp);
      done = true;
    } catch {
      /* 今天还没回验过 */
    }
    if (!done) {
      const { readRuleChangeLog } = await import("../src/lib/market/optimize.ts");
      const { pollRuleChangeEffect, appendRuleChangeEffect, MIN_DAYS_AFTER } = await import(
        "../src/lib/market/rule-change-effect.ts"
      );
      const changes = (await readRuleChangeLog()).slice(0, 8);
      const ownerBook = await readUserBook<Day>(OWNER_ID).catch(() => null);
      const allTrades = (ownerBook?.days ?? []).flatMap((d) => d.trades);
      const tradingDays = [...new Set((ownerBook?.days ?? []).map((d) => d.date))].sort();
      let evaluated = 0;
      for (const c of changes) {
        const effect = await pollRuleChangeEffect({
          at: c.at,
          key: c.key,
          from: c.from,
          to: c.to,
          trades: allTrades
            .filter((t) => t.exit != null)
            .map((t) => ({ entryDate: t.exitDate ?? "", ret: (t.exit! - t.entry) / t.entry })),
          tradingDays,
        });
        if (effect) {
          await appendRuleChangeEffect(effect);
          evaluated += 1;
          if (effect.verdict === "ineffective") {
            console.log(`${time} 规则回验：${c.key} ${c.from}→${c.to} 判无效 —— ${effect.reason}`);
            await pushBestEffort(
              "赤轨规则回验",
              [`${c.key} 从 ${c.from} 改到 ${c.to}：${effect.reason}`, effect.revertAdvice ?? ""].join("\n"),
            );
          }
        }
      }
      await writeFile(stamp, String(Date.now()));
      if (evaluated > 0) console.log(`${time} 规则改动回验：${evaluated} 条（观察期 ≥${MIN_DAYS_AFTER} 交易日才判）`);
    }
  } catch (error) {
    console.error(`${time} 规则改动回验失败（不影响记账）:`, error);
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

// 短命进程的最后一道保险：等所有已排队的推送真正发完再退出。
// pushBestEffort 已在各处 await，这里是兜底（例如将来有人又加了一处没 await 的调用）。
await flushPushes();
