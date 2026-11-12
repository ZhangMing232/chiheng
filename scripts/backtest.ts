/**
 * 这个文件是干什么的：
 * 无前视回测引擎。把选股策略放到历史日线上重跑一遍，看它们到底赚不赚钱。
 *
 * 你需要知道的：
 * 「无前视」是这台机器的唯一铁律——第 t 天收盘后，只准看第 t 天及之前的 K 线。
 * 选出来的股票在**第 t+1 天**才成交，而且只有当天的**最低价**碰到买入价才算成交
 * （限价单，不追高）。出场沿用 journal-book 的 exitFill，它已经处理了 T+1，
 * 并且同一天两边都碰到时按最坏情况（先止损）算。
 *
 * 已知的三处近似，读结果时要心里有数：
 * 1. 股票池是「今天还在交易的股票」，已退市的不在里面，结果偏乐观（幸存者偏差）
 * 2. 历史换手率（已用流通市值反推）、市盈率/市净率（已用 baostock 逐日序列补上，见
 *    data/backtest/pe-history/）现在都拿得到了；只有「历史总市值」仍只有今日快照
 *    （cap.json），value 的 100 亿门槛用 BT_CAP 卡的是今天的数，属已知近似。
 * 3. 成交额用「成交量 × 收盘价」折算，与实际成交额略有出入
 *
 * 还有一处更要紧的：**这个文件里的选股条件是另抄了一份，和线上
 * `src/lib/market/strategies.ts` 已经对不上了。** 已知对不上的地方：
 *   - 放量突破：线上 d20 上限 10，这里写的是 20（线上是收紧过的，bk2/bk3/bk4 才是 10）
 *   - 线上还有 tradable 的几道闸（ST、股价 < 4、市值 < 40 亿、贴涨跌停），
 *     回测里只有「股价 < 4」，因为 K 线不带市值和 ST 标记
 * 所以这里的数字衡量的是「略微宽松一点的放量突破」，不是线上那一版。
 * 改线上策略时记得回来同步这里，或者干脆让两边共用同一份条件。
 *
 * 2026-10-12 学 Vibe-Research 的三件套（判定在 src/lib/market/backtest-gate.ts，可单测）：
 *   A 请求闸口：开跑前 decideGate() 三问（样本/覆盖/预热），答不出 → Refusal 直接退出，
 *     没有「带一堆警告勉强跑」的第三种。
 *   B 费用对照：同一套交易再跑一遍费用清零（runPass(_, 0)），drag 单列——
 *     只看有费收益会高估策略。
 *   E 来源标注：每笔 Trade 带 ref（K 线缓存文件@信号日），事后复核能回到原始 bar。
 *
 * 2026-10-06 补上一条：放量突破的**换手率 ≥ 2%** 这道闸以前也缺，现在用
 * 流通市值反推补上了（成交额 ÷ 流通市值，和腾讯的 hsl 同口径）。
 * 跑 `node scripts/build-caps.mjs` 生成缓存（同时建 cap.json 总市值和
 * floatcap.json 流通市值，收盘后每天自动重建）；没有缓存时会在开头大声提示
 * 这道闸没生效，不会静默地退回宽松口径。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts
 */

import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  COMMISSION_RATE,
  COMMISSION_MIN,
  TRANSFER_FEE,
  STAMP_TAX,
  SLIPPAGE,
  CAPITAL_PER_TRADE,
  FEE_ONLY,
  roundTripFee,
} from "@/lib/market/fill-model";
import { exitFill } from "@/lib/market/journal-book";
import { boardLimit } from "@/lib/market/model";

// 历史 PE/PB 日序列（baostock 抓取，data/backtest/pe-history/pe-<code>.json）。
// value 变体用来做 PE<=18 / PB<=2 过滤 + 按 PE 锚定买卖价。这是真实逐日序列，
// 不是市值快照回填（那会前视）。拿不到的交易日为 null，由策略函数决定怎么处理。
type PeRow = { peTTM: number | null; pbMRQ: number | null; isST: boolean };
const peMap: Record<string, Map<string, PeRow>> = {};
// 总市值快照（今日，单位亿），value 变体的 100 亿门槛用，也供 BT_CAP 全局闸。
// 这是今天的市值不是历史市值，属已知近似（见文件头注释），不能当精确结论。
let capMap: Record<string, number> = {};
// 个股自身 PE 历史分位（pct：0=自身历史最便宜，100=最贵；streak：连续低位天数）。
// 由 buildPePctMap() 在 loadPeHistory 之后预计算，策略函数按 m.date 查，避免每笔重复扫全序列。
// 这是把「PE≤18 绝对值」改写成「相对自身历史便宜 + 持续低位」的核心结构——直接修复价值策略的 value-trap 失败。
const pePctMap: Record<string, Map<string, { pct: number; streak: number }>> = {};

async function loadPeHistory(): Promise<void> {
  const dir = `${CACHE}/../pe-history`;
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    console.log("（没有 pe-history 目录，value 变体不可用；先跑 python3 scripts/fetch-pe-batch.py）\n");
    return;
  }
  let n = 0;
  for (const f of files) {
    if (!f.startsWith("pe-") || !f.endsWith(".json")) continue;
    const code = f.slice(3, 9);
    try {
      const d = JSON.parse(await readFile(`${dir}/${f}`, "utf8")) as {
        series?: Array<{ date: string; peTTM?: number | null; pbMRQ?: number | null; isST?: boolean }>;
      };
      const m = new Map<string, PeRow>();
      for (const r of d.series ?? []) {
        m.set(r.date, { peTTM: r.peTTM ?? null, pbMRQ: r.pbMRQ ?? null, isST: r.isST === true });
      }
      peMap[code] = m;
      n += 1;
    } catch {
      // 坏文件跳过，不阻塞整体
    }
  }
  if (n > 0) console.log(`历史 PE/PB 缓存 ${n} 只（value 变体用）\n`);
}

/**
 * 预计算个股自身 PE 历史分位（无前视）。
 *
 * value 失败根因：用「PE≤18 绝对阈值」= value trap（绝对便宜 ≠ 相对便宜，低 PE 常是低质量或下行周期）。
 * 这里改成「个股自身 PE 在过往 windowDays 交易日的分位」：pct≤cheapThresh = 相对自身历史便宜；
 * streak = 连续处于低位天数，用来要求「持续性」而非单日跳便宜。
 *
 * 计算逻辑在 src/lib/market/pe-percentile.ts（纯函数），守门测试钉死「无前视」：
 * 砍掉未来数据重算，之前每一天的分位必须逐点相同。
 */
function buildPePctMap(windowDays = 250, cheapThresh = 25): void {
  let built = 0;
  for (const code of Object.keys(peMap)) {
    const series = peMap[code];
    const entries: PeSeriesEntry[] = [];
    for (const [date, row] of series) entries.push({ date, pe: row.peTTM });
    const m = computePePercentiles(entries, { windowDays, cheapThresh, minHistory: 60 });
    if (m.size) pePctMap[code] = m;
    built += 1;
  }
  console.log(`个股 PE 历史分位预计算完成（${built} 只）\n`);
}

/**
 * 低频家族慢因子预计算（2026-11-09）：动量 / 52 周高点距离 / 120 日波动。
 * 一次扫全 K 线建表，策略函数按 (code, date) 查——和 pePctMap 同一模式，
 * 避免选股循环里每股每日重扫长窗口。全部**只用 ≤ 当日**的数据（无前视）。
 *
 * 动量口径（经典 12-1 月式的短版，预登记不再动）：
 *   mom120 = 近 5 日收盘 / 125 日前收盘 − 1（跳过最近 5 日，隔离短期反转污染）
 *   mom60  = 近 5 日收盘 / 65 日前收盘 − 1（同款跳法）
 *   near52w = 当日收盘 / 近 250 根最高价（含今日）
 *   vol120 = 近 120 根日收益的总体标准差
 */
type SlowFac = { mom60: number; mom120: number; near52w: number; vol120: number; hi20: number; highAge: number; loRatio: number; limitStreak: number; themeHot: number };
const slowFacMap = new Map<string, Map<string, SlowFac>>();

function buildSlowFactorMaps(klines: Map<string, Row[]>): void {
  for (const [id, rows] of klines) {
    const code = id.replace(/[^0-9]/g, "");
    const byDate = new Map<string, SlowFac>();
    // 连板天数口径（2026-11-09）：按板限贴板判定（创业/科创 20%、北交 30%、
    // 其余 10%），ST 的 5% 板限这里拿不到 isST，按 10% 算会把 ST 的 5-9.9% 误计
    // 成涨停——已知近似，事件函数入口有 m.isST 精确闸兜底。
    const boardLim = id.startsWith("sh688") || id.startsWith("sz300") ? 20 : id.startsWith("bj") ? 30 : 10;
    let streak = 0;
    for (let i = 65; i < rows.length; i++) {
      const r = rows[i]!;
      const past5 = rows[i - 5];
      const mom60 = past5 ? past5.c / rows[i - 65]!.c - 1 : NaN;
      const mom120 = i >= 125 && past5 ? past5.c / rows[i - 125]!.c - 1 : NaN;
      let maxH = -Infinity, hiAge = 0, loL = Infinity;
      for (let j = Math.max(0, i - 249); j <= i; j++) {
        const h = rows[j]!.h;
        if (h > maxH) { maxH = h; hiAge = i - j; }
        loL = Math.min(loL, rows[j]!.l);
      }
      let maxH20 = -Infinity;
      for (let j = Math.max(0, i - 19); j <= i; j++) maxH20 = Math.max(maxH20, rows[j]!.h);
      let sum = 0, sum2 = 0, n = 0;
      for (let j = Math.max(1, i - 119); j <= i; j++) {
        const ret = rows[j]!.c / rows[j - 1]!.c - 1;
        sum += ret; sum2 += ret * ret; n += 1;
      }
      const mean = n ? sum / n : 0;
      const vol120 = n > 1 ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : NaN;
      const chgPct = i > 0 ? (r.c / rows[i - 1]!.c - 1) * 100 : 0;
      streak = chgPct >= boardLim - 0.15 ? streak + 1 : 0;
      byDate.set(r.date, {
        mom60, mom120,
        near52w: maxH > 0 ? r.c / maxH : NaN,
        vol120,
        hi20: maxH20 > 0 ? r.c / maxH20 : NaN,
        highAge: hiAge,
        loRatio: loL > 0 ? r.c / loL : NaN,
        limitStreak: streak,
        themeHot: 0,
      });
    }
    if (byDate.size) slowFacMap.set(code, byDate);
  }
  console.log(`低频慢因子预计算完成（${slowFacMap.size} 只：动量/52周高点/波动/20日高/高点年代/距底）\n`);
}

/**
 * 题材热度预计算（2026-11-09 深夜，用户要「短线热点策略」）：
 * 概念板块当日涨停家数 → 每只票记「所属最热板块的当日电压」（themeHot）。
 * 剔标签板（融资融券/昨日涨停这类统计标签）与巨型板（>800 成员），
 * 成员 10~800 的真题材板才计。lookup 用法同 slowFacMap。
 */
const themeHeatMap = new Map<string, Map<string, number>>();

function buildThemeHeatMap(klines: Map<string, Row[]>): void {
  let raw: { boards: { code: string; name: string; members: string[] }[] } | null = null;
  try {
    raw = JSON.parse(readFileSync("data/backtest/concepts.json", "utf8"));
  } catch {
    console.log("概念板数据缺失（data/backtest/concepts.json），题材热度为空");
    return;
  }
  const TAG = /(热股|高换手|高振幅|多板|涨停|跌停|首亏|预增|预亏|重仓|减仓|增仓|融资|股通|QFII|亏损|题材股|破净|高价|低价|百元|次新|AH|同股)/;
  const boards = raw.boards.filter((b) => b.members.length >= 10 && b.members.length <= 800 && !TAG.test(b.name));
  // 稀疏表（2026-11-10 修 OOM）：只存「板当日涨停 ≥3」的日子——事件唯一的阈值；
  // 每票涨停日只扫一遍（成员共享时不再重复扫 k 线）。
  const memberOf = new Map<string, string[]>();
  for (const b of boards) {
    for (const id of b.members) {
      const arr = memberOf.get(id) ?? [];
      arr.push(b.code);
      memberOf.set(id, arr);
    }
  }
  const stockLimits = new Map<string, string[]>();
  for (const [id, rows] of klines) {
    if (!memberOf.has(id)) continue;
    const lim = id.startsWith("sh688") || id.startsWith("sz300") ? 20 : id.startsWith("bj") ? 30 : 10;
    const dates: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const chg = (rows[i]!.c / rows[i - 1]!.c - 1) * 100;
      if (chg >= lim - 0.15) dates.push(rows[i]!.date);
    }
    if (dates.length) stockLimits.set(id, dates);
  }
  for (const b of boards) {
    const daily = new Map<string, number>();
    for (const id of b.members) for (const d of stockLimits.get(id) ?? []) daily.set(d, (daily.get(d) ?? 0) + 1);
    for (const id of b.members) {
      const code = id.replace(/[^0-9]/g, "");
      let m = themeHeatMap.get(code);
      if (!m) { m = new Map(); themeHeatMap.set(code, m); }
      for (const [date, n] of daily) if (n >= 3 && n > (m.get(date) ?? 0)) m.set(date, n);
    }
  }
  console.log(`题材热度预计算完成（${boards.length} 个概念板，${themeHeatMap.size} 只票带 ≥3 涨停热度日）`);
}

/** 只存 ≥3 的稀疏表：查不到就是没烧（0）。 */
function themeHotOf(id: string | undefined, date: string): number {
  return themeHeatMap.get((id ?? "").replace(/[^0-9]/g, ""))?.get(date) ?? 0;
}

/** 低频家族统一执行骨架（预登记，五个策略共用，参数只定一次不再调）：
 *  昨收限价买 · 止损 −10%（40 天持有给点呼吸空间，比短持有 −8% 宽一档）·
 *  止盈 +25%（让赢家跑）· 持有 40 个交易日（≈ 两个月，低频口径）。 */
function slowSignal(m: ReturnType<typeof metrics>, score: number): Signal {
  const buy = m.prev;
  return { buy, stop: buy * 0.9, sell: buy * 1.25, score };
}

function slowGates(m: ReturnType<typeof metrics>): boolean {
  return !(m.isST === true) && m.c >= 4 && m.amountWan >= 3000;
}

function slowFacOf(id: string | undefined, date: string): SlowFac | undefined {
  return slowFacMap.get((id ?? "").replace(/[^0-9]/g, ""))?.get(date);
}

/** 120 日动量（跳 5 日）：买近期赢家，赌延续。经典动量因子，本项目从未测过。 */
function mom120Buy(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (!slowGates(m)) return null;
  const f = slowFacOf(id, m.date);
  if (!f || !isFinite(f.mom120) || f.mom120 <= 0) return null;
  return slowSignal(m, f.mom120 * 100);
}

/** 60 日动量（跳 5 日）：同上，短一档的形成期。 */
function mom60Buy(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (!slowGates(m)) return null;
  const f = slowFacOf(id, m.date);
  if (!f || !isFinite(f.mom60) || f.mom60 <= 0) return null;
  return slowSignal(m, f.mom60 * 100);
}

/** 52 周高点效应：贴着年内新高的票，动量最强。门闸 0.9（预登记），评分贴近程度。 */
function near52wBuy(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (!slowGates(m)) return null;
  const f = slowFacOf(id, m.date);
  if (!f || !isFinite(f.near52w) || f.near52w < 0.9) return null;
  return slowSignal(m, f.near52w * 100);
}

/** 低波动异象：低波股票风险调整后长期跑赢（经典异象）。评分反着给（波动越低分越高）。 */
function lowVolBuy(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (!slowGates(m)) return null;
  const f = slowFacOf(id, m.date);
  if (!f || !isFinite(f.vol120) || f.vol120 <= 0) return null;
  return slowSignal(m, -f.vol120 * 1000);
}

/** 动量 × 价值混合：便宜（自身 PE 分位 ≤50）+ 赢家（120 日动量为正）——
 *  经典价值/动量双因子组合。价值做门闸，动量做排序。 */
function momValueBuy(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (!slowGates(m)) return null;
  const f = slowFacOf(id, m.date);
  if (!f || !isFinite(f.mom120) || f.mom120 <= 0) return null;
  const pp = pePctMap[(id ?? "").replace(/[^0-9]/g, "")]?.get(m.date);
  if (!pp || !isFinite(pp.pct) || pp.pct > 50) return null;
  return slowSignal(m, f.mom120 * 100);
}
import { holdOf } from "@/lib/market/strategies";
import type { BacktestRun, BacktestStyleStat } from "@/lib/market/backtest-runs";
import { RUNS_PATH } from "@/lib/market/backtest-runs";
import type { StyleId, StrategySpec } from "@/lib/market/strategies";
import type { Bar } from "@/lib/market/types";
import {
  ACTIVE_FACTORS,
  analyzeFactors,
  gateMonotonic,
  gateT,
  gateHalves,
  gateResample,
  gateBonferroni,
  gateFdr,
  gateTradable,
  diagnoseShrinkDays,
  diagnoseShrinkBull,
} from "@/lib/market/factors";
import type { DailyRow } from "@/lib/market/factors";
import { detectWyckoffSpring } from "@/lib/market/wyckoff-spring";
import { decideGate, costDragRows, formatDragRow, klineRef } from "@/lib/market/backtest-gate";
import { byDay, dayRowsOf, benchRowsOf } from "@/lib/market/backtest-day";
import { loadQueueFactors, applyVerdictsToQueue } from "@/lib/market/factor-queue";
import { dsr as dsrOf, perPeriodSharpe, std as trialStd } from "@/lib/market/robustness";
import { pitValue, recordsOf } from "@/lib/market/fundamentals";
import type { FundamentalFile } from "@/lib/market/fundamentals";
import { specBacktestSignal, loadGenomeSpec, type SpecBacktestRow } from "@/lib/market/spec-backtest";
import { clusterTOf, halvesSameSignOf, judgeGenomeVerdict } from "@/lib/market/genome-verdict";
import { shouldAvoid } from "@/lib/market/lhb-avoid";
import { loadAvoidIndex } from "@/lib/market/lhb-avoid-index.server";
import { computePePercentiles, type PeSeriesEntry } from "@/lib/market/pe-percentile";

/** 财报基本面落盘文件（scripts/fetch-fundamentals.py / .ts 生成）。读不到就当没有——
 * 基本面因子全部取 null 自动退出分档，不影响量价因子检验。 */
async function loadFundamentals(): Promise<FundamentalFile | null> {
  try {
    const raw = await readFile(new URL("../data/backtest/fundamentals.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as FundamentalFile;
    return parsed && typeof parsed === "object" && parsed.byCode ? parsed : null;
  } catch {
    return null;
  }
}

/** K 线日期 "2026-09-30" → "20260930"（fundamentals.json 的 ann 口径）。 */
function ymd(date: string): string {
  return date.replaceAll("-", "");
}

/** 回测多长。250 个交易日约等于一年。 */
const LOOKBACK = 250;
/**
 * 单次从腾讯接口抓多少根日线。默认 800（≈3.2 年），之前是 LOOKBACK+80=330。
 * 拉长是为了在更长历史（多轮 regime）上重跑同一套策略，看是否真过双闸。
 * BT_KLINE_DAYS 可临时调小（如 330）做对照、或回归旧口径。
 */
const KLINE_FETCH_DAYS = Number(process.env.BT_KLINE_DAYS ?? 800);
/**
 * 交易 / 因子 / 重采样窗口。默认回退 LOOKBACK；BT_WINDOW 可临时拉长（如 750）
 * 在更长历史上重跑同一套策略，且只纳 ≥ 该长度的票，保证对照是同窗口。
 */
const WINDOW = Number(process.env.BT_WINDOW ?? LOOKBACK);
/** 抽多少只股票。全市场五千多只全拉太慢，抽样已经能看出方向。 */
const SAMPLE = Number(process.env.BT_SAMPLE ?? 300);
/** 每套策略每天最多买几只，和线上一致。 */
const MAX_POSITIONS = 10;
/** 成交与费用口径搬到 scripts/lib/fill-model.ts（2026-11-10，borrow-list P1-3 单一出处）：
 *  实盘侧（track-signals / record-journal / review-auction）与回测从同一套数字取，
 *  判决扣的费和实盘对账扣的费不再各算各的。数值一字未改，re-export 保持旧 API。
 *  佣金 万2.5 双边（不满 ¥5 按 ¥5）+ 过户费 万0.1 双边 + 印花税 万5 卖出单边
 *  = 0.00102；滑点单边默认万 10（BT_SLIPPAGE 可调，估值不是实测，披露里单列）。 */
export {
  COMMISSION_RATE,
  COMMISSION_MIN,
  TRANSFER_FEE,
  STAMP_TAX,
  SLIPPAGE,
  CAPITAL_PER_TRADE,
  roundTripFee,
};
/** 纯手续费（不含滑点）的一来一回合计——披露段和成本对照用，单一出处 fill-model。 */
const FEE = FEE_ONLY;
const CACHE = "data/backtest/kline";

/**
 * 这套策略拿几个交易日。
 *
 * 默认值一律查 strategies.ts 的 `holdOf`（STYLE_HOLD 表）——那是持股天数的唯一
 * 定义处。以前这里写死 `rebound ? 10 : undefined`，和记账脚本、网页端各写一遍，
 * 改一处忘两处，而这个数直接决定结算价记多少，写错了账就废了。
 *
 * BT_HOLD 环境变量仍然优先，且**只对中期反转生效**（保持原语义）：它存在的意义是
 * 扫描持有期看信号在哪个天数最强，不该顺带把别的策略一起改了。
 */
function holdFor(key: string): number {
  // BT_HOLD 同时扫 spring：威科夫说 Spring→SOS→LPS 要 2~4 周（14~28 日），
  // 而项目已实测短周期因子普遍失效，所以持有期必须能扫。
  if ((key === "rebound" || key === "spring") && process.env.BT_HOLD) return Number(process.env.BT_HOLD);
  // 基因组 spec 自带持有期（spec.holdDays），不看 StyleId 的默认表。
  const own = STRATEGIES[key]?.hold;
  if (own != null) return own;
  return holdOf(key as StyleId);
}/**
 * 数据目录。CHIHENG_DATA_DIR 可以换到别处（测试用），和 src/lib/market/gate-log.ts
 * 同一个约定。没设就是项目根下的 data/。
 */
const DATA_DIR = process.env.CHIHENG_DATA_DIR ?? "data";
/** 归因/探路这类研究性诊断的落盘文件。因子表落 factor-runs.jsonl，两类分开。 */
const DIAG_LOG = `${DATA_DIR}/backtest/factor-diag.jsonl`;
const KLINE_HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" };

/**
 * 追加一条诊断记录（factor-diag.jsonl）。
 *
 * 为什么是 append 不是覆盖写一个 json：三种诊断（缩量翻脸 / 止跌溢价 / 资金流探路）
 * 形状差别很大，塞一个文件里得靠 kind 分桶；而且 book-file.ts 以前被「写一半的文件
 * 把整份数据废掉」坑过——append 天然幂等，跑崩了最多少一条，不会毁掉已有的。
 */
async function appendDiag(record: Record<string, unknown>): Promise<void> {
  await mkdir(`${DATA_DIR}/backtest`, { recursive: true });
  await appendFile(DIAG_LOG, JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n");
  console.log(`诊断已追加 → ${DIAG_LOG}（kind=${String(record.kind)}）`);
}

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

async function fetchKline(id: string, noFq = false): Promise<Row[]> {
  // 指数没有复权数据，带 qfq 会返回 501，只能取原始 day
  const url = noFq
    ? `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,${KLINE_FETCH_DAYS}`
    : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,${KLINE_FETCH_DAYS},qfq`;
  const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
  const rows = body.data?.[id]?.qfqday ?? body.data?.[id]?.day ?? [];
  const out: Row[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const o = Number(r[1]);
    const c = Number(r[2]);
    const h = Number(r[3]);
    const l = Number(r[4]);
    const v = Number(r[5]);
    if (![o, c, h, l].every(Number.isFinite)) continue;
    out.push({ date: r[0], o, c, h, l, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

/**
 * 取一批票的日线（缓存 + 保鲜刷新）。
 *
 * freshThrough：缓存保鲜尺子（窗口脊上某个日期）。缓存里最后一根 K 线早于它就
 * 重抓——以前缓存只抓不刷，10 月补抓的文件带 09-30 后除权重述、冻住的没有，
 * **同一套样本两套 qfq 口径**，60 日跌幅跨股排名不可比（10-24 基线问题②，
 * 用户已拍板修）。尺子传空 = 不刷新（老行为）。
 *
 * 重抓失败留着旧缓存：旧口径好歹是真数据；若因此把票从样本里删掉，样本就变了，
 * 三批互换（BT_OFFSET）的对照基准跟着晃，比口径旧更伤。
 */
async function loadKlines(ids: string[], freshThrough = ""): Promise<Map<string, Row[]>> {
  await mkdir(CACHE, { recursive: true });
  const out = new Map<string, Row[]>();
  let done = 0;
  let notedError = false;
  let refreshed = 0;
  let keptStale = 0;
  const queue = [...ids];
  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      let rows: Row[] | null = null;
      try {
        const cached = await readFile(`${CACHE}/${id}.json`, "utf8");
        const parsed = JSON.parse(cached) as Row[];
        if (Array.isArray(parsed) && parsed.length > 0) rows = parsed;
      } catch {
        rows = null;
      }
      const lastBar = rows && rows.length > 0 ? rows[rows.length - 1].date : "";
      const stale = rows != null && freshThrough !== "" && lastBar < freshThrough;
      // 缓存条数不够（之前只抓了 LOOKBACK+80 根）也要补长，否则拉到 800 根的票混着
      // 331 根的票，跨股窗口/排名不可比（延用 10-24「同窗口」前提）。
      const tooShort = rows != null && rows.length < KLINE_FETCH_DAYS;
      const reason = !rows ? "缺失" : stale ? "超龄" : tooShort ? "太短" : "";
      if (!rows || stale || tooShort) {
        let fresh: Row[] | null = null;
        for (let attempt = 0; attempt < 3 && !fresh; attempt += 1) {
          try {
            const got = await fetchKline(id);
            if (got.length > 0) fresh = got;
          } catch (error) {
            if (attempt === 2 && !notedError) {
              notedError = true;
              console.error(`  取 ${id} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        // 只在新抓的比缓存长时才覆盖，避免新上市股（历史不足 800 根）陷入无限重抓
        if (fresh && fresh.length >= (rows?.length ?? 0)) {
          refreshed += 1;
          rows = fresh;
          await writeFile(`${CACHE}/${id}.json`, JSON.stringify(fresh));
        } else if (stale && !fresh) {
          keptStale += 1;
        }
      }
      if (done < 3) process.stderr.write(`  [诊断] ${id} -> ${rows ? rows.length + " 根" : "空"}${reason ? `（${reason}重抓）` : ""}\n`);
      if (rows && rows.length > WINDOW) out.set(id, rows);
      done += 1;
      if (done % 50 === 0) process.stderr.write(`  已取 ${done}/${ids.length} 只\n`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  if (refreshed > 0 || keptStale > 0) {
    console.log(
      `缓存保鲜：超龄重抓 ${refreshed} 只（最后 K 线早于 ${freshThrough}）` +
        `${keptStale > 0 ? `，${keptStale} 只重抓失败留用旧缓存` : ""}\n`,
    );
  }
  return out;
}

/**
 * 给因子检验准备一套独立样本的数据（换样本 G4 用）。
 * 和 main 里主样本那套逻辑是同一份，只是抽出来能对任意一批票重跑。
 * 返回因子检验需要的全部：klines、idxOf、dates、benchOver。
 */
async function factorPrep(sampleIds: string[], capFloor: number) {
  // 窗口脊和 main 一个口径：锚指数交易日日历（见 main 里 dates 那段注释）。
  // 以前这里取 klines Map 第一只股票，worker 完成顺序非确定性，G4 换样本的
  // 窗口和主样本可能不是同一段日子，两段对照就失去了「同窗口」这个前提。
  const bench = await fetchKline("sh000300", true);
  const dates = bench.map((r) => r.date);
  const freshThrough = dates[Math.max(0, dates.length - 3)] ?? "";
  const klines = await loadKlines(sampleIds, freshThrough);
  if (capFloor > 0) {
    let cap: Record<string, number> = {};
    try {
      cap = JSON.parse(await readFile(`${CACHE}/../cap.json`, "utf8")) as Record<string, number>;
    } catch {
      cap = {};
    }
    for (const id of [...klines.keys()]) {
      const value = cap[id];
      if (value != null && value >= capFloor) continue;
      klines.delete(id);
    }
  }
  const idxOf = new Map<string, Map<string, number>>();
  for (const [id, rows] of klines) {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.date, i));
    idxOf.set(id, map);
  }
  const uniRet = new Float64Array(dates.length);
  for (let i = 1; i < dates.length; i += 1) {
    let sum = 0;
    let n = 0;
    for (const [id, rows] of klines) {
      const pos = idxOf.get(id);
      if (!pos) continue;
      const a = pos.get(dates[i - 1]);
      const b = pos.get(dates[i]);
      if (a == null || b == null) continue;
      const from = rows[a].c;
      const to = rows[b].c;
      if (from > 0 && to > 0) {
        sum += to / from - 1;
        n += 1;
      }
    }
    uniRet[i] = n > 0 ? sum / n : 0;
  }
  const benchOver = (fromIdx: number, toIdx: number): number => {
    let acc = 1;
    for (let i = fromIdx + 1; i <= toIdx && i < uniRet.length; i += 1) acc *= 1 + uniRet[i];
    return acc - 1;
  };
  return { klines, idxOf, dates, benchOver };
}

/** 只用第 i 天及之前的数据算指标。这是「无前视」的落地点。 */
/**
 * 第 i 天的全部指标。**只用 <= i 的数据，无前视。**
 *
 * id 只给威科夫 Spring 的跌停闸用（判板位），其余逻辑不依赖它，
 * 所以放在末尾且有默认值——现有调用点一行都不用改。
 */
function metrics(
  rows: Row[],
  i: number,
  floatCap: number | null = null,
  turnoverGateOn = false,
  id = "",
  ext?: ExtData | null,
) {
  const at = (k: number) => (i - k >= 0 ? rows[i - k].c : null);
  const c = rows[i].c;
  // 事件数据的时间口径：默认查 t 日（盘后公布、t+1 开盘前可得，见 EXT_LAG 注释）；
  // BT_EXT_LAG=1 时严格滞后一根 K 线，只查更早那根 bar 的日期。
  // 用 K 线自身的日期查 ext（ext 按日历日索引），停牌跳日也自然对得上。
  const extDate = EXT_LAG ? (rows[i - 1]?.date ?? rows[i].date) : rows[i].date;
  const pct = (base: number | null) => (base && base > 0 ? ((c - base) / base) * 100 : null);
  const prev = i - 1 >= 0 ? rows[i - 1].c : c;
  const chg = prev > 0 ? ((c - prev) / prev) * 100 : 0;
  const vol = rows[i].v;
  const avg5 = avg(rows.slice(Math.max(0, i - 4), i + 1).map((r) => r.v));
  const avg20 = avg(rows.slice(Math.max(0, i - 19), i + 1).map((r) => r.v));
  // 成交量单位是手，×100 股 × 价格 = 元，再换成万元
  const amountWan = (vol * 100 * c) / 1e4;

  // —— 新增因子指标（都只用 <= i 的数据，无前视）——
  const d5 = pct(at(5));
  const d20 = pct(at(20));
  const win20 = rows.slice(Math.max(0, i - 19), i + 1);
  const win60 = rows.slice(Math.max(0, i - 59), i + 1);
  const rets20 = retSeries(rows, i, 20);
  const closes20 = win20.map((r) => r.c);
  const ma20 = avg(closes20);
  const sd20Price = stdOf(closes20);

  let rsi14: number | null = null;
  if (i >= 14) {
    let gain = 0;
    let loss = 0;
    for (let k = i - 13; k <= i; k += 1) {
      const diff = rows[k].c - rows[k - 1].c;
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    rsi14 = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const bias20 = ma20 > 0 ? c / ma20 - 1 : null;
  const bollB = sd20Price != null && sd20Price > 0 ? (c - (ma20 - 2 * sd20Price)) / (4 * sd20Price) : null;
  const amp20 = avg(win20.map((r) => (r.c > 0 ? ((r.h - r.l) / r.c) * 100 : 0)));
  const corrVRet = corrOf(win20.map((r) => r.v), rets20);
  const shrinkDays = win20.filter((r) => r.v < avg20).length;
  const high20 = Math.max(...win20.map((r) => r.h));
  const low20 = Math.min(...win20.map((r) => r.l));
  const low60 = Math.min(...win60.map((r) => r.l));
  const distHigh20 = high20 > 0 ? c / high20 - 1 : null;
  const distLow60 = low60 > 0 ? c / low60 - 1 : null;
  const rangePos20 = high20 > low20 ? (c - low20) / (high20 - low20) : null;

  // —— 2026-10-06 新扩充的三个因子（都只用 <= i 的数据）——
  const std20 = stdOf(rets20);
  const std60 = stdOf(retSeries(rows, i, 60));
  const volCompress = std20 != null && std60 != null && std60 > 0 ? std20 / std60 : null;
  const dayHi = rows[i].h;
  const dayLo = rows[i].l;
  const bodyLow = Math.min(rows[i].o, c);
  const lowerWick = dayHi > dayLo ? (bodyLow - dayLo) / (dayHi - dayLo) : null;
  let downStreak = 0;
  for (let k = i; k >= 1; k -= 1) {
    if (rows[k].c < rows[k - 1].c) downStreak += 1;
    else break;
  }

  // 威科夫 Spring（假跌破）。阈值与标定纪律见 src/lib/market/wyckoff-spring.ts。
  //
  // ⚠️ buildDaily 的 `idx < 61` 会让第 61~65 天的票恒无 Spring（它要回看到 i-65）。
  // 这是**样本起点少几天，不是前视泄漏**——宁可少算也不偷看。
  // ⚠️ boardLimit(id, "") 判不出 ST（回测没有股票名），所以回测里 ST 股的跌停闸偏松，
  // 这类票会混进 Spring 样本。K 线不带 ST 标记，本轮无法修。
  const spring = detectWyckoffSpring(rows, i, boardLimit(id, ""));

  return {
    c,
    /** 信号日日期（YYYY-MM-DD）。策略函数要用它去查 pePctMap（个股自身 PE 历史分位），避免把绝对阈值当相对分位。无前视：策略只拿得到 t 日这天的分位。 */
    date: rows[i].date,
    /**
     * 买卖价基准 = 信号日收盘 `c`（对「次日下单」而言它就是「昨收」）。
     *
     * 2026-10-28 修：以前是 `rows[i-1].c`（信号日**前一天**收盘），和线上对不上——
     * 线上 record-journal 的 breakoutOrder 用 `prevClose(quote) = 现价/(1+涨跌幅)`，
     * 次日跑的时候取到的是信号日当天收盘。基准差一天，放量突破这种信号日大涨的
     * 策略能差 3~5 个点，等于回测一直在测「晚一天」的那一档买价。
     *
     * 注意：`chg`（当日涨跌幅）仍然用 `rows[i-1].c` 算，那是对的，不能跟着改。
     */
    prev: c,
    open: rows[i].o,
    low: rows[i].l,
    prevLow: i - 1 >= 0 ? rows[i - 1].l : rows[i].l,
    chg,
    d5,
    d10: pct(at(10)),
    d20,
    d60: pct(at(60)),
    momAccel: d5 != null && d20 != null ? d5 - d20 : null,
    rsi14,
    bias20,
    std20,
    std60,
    amp20,
    /**
     * 当日振幅（%）：(h-l)/c。
     * 仓库里 amp20 是这同一套公式的 20 日均值，所以这里的单日值和 amp20 同源同口径。
     * 和线上 Quote.amp（腾讯 zf）差一个分母：腾讯用昨收，这里用当日收盘。
     * 给策略 spec 的表达式用时按本口径（spec-backtest.ts 的 FIELD_SOURCES 里写明了）。
     */
    ampDay: c > 0 && rows[i].h >= rows[i].l ? ((rows[i].h - rows[i].l) / c) * 100 : null,
    corrVRet,
    shrinkDays,
    distHigh20,
    distLow60,
    bollB,
    rangePos20,
    volRatio: avg5 > 0 ? vol / avg5 : 0,
    volShrink: avg20 > 0 ? avg5 / avg20 : 1,
    amountWan,
    /**
     * 换手率 = 成交额 / 流通市值。用本地缓存的流通市值反推，
     * 口径和腾讯的 hsl 一致（实测 5224 只里 99.8% 吻合）。
     * 拿不到流通市值时是 null——**不是 0**。0 会被读成「一点没换手」，
     * 而真相是「不知道」，这两件事不能混。
     */
    turnover: floatCap && floatCap > 0 ? amountWan / (floatCap * 100) : null,
    /**
     * 这道闸这次是否生效。三种状态必须分清，混在一起会得出「关掉闸反而 0 笔」
     * 这种荒谬结论：
     *   闸开 + 查得到流通市值 → 按 2% 卡
     *   闸开 + 查不到该票      → 拒绝（默认不放行，否则宽松口径偷偷回来了）
     *   闸关（BT_TURNOVER=0）  → 完全不卡
     */
    turnoverGateOn,
    floatCap,
    lowerWick,
    volCompress,
    downStreak,
    // Spring 四件套。都是 null 而不是 0：null 是「没 Spring」，0 会被读成「强度为零」。
    springStrength: spring ? spring.strength : null,
    springAge: spring ? spring.age : null,
    springLow: spring ? spring.springLow : null,
    springRangeHigh: spring ? spring.springLow + spring.rangeHeight : null,
    // 北向/两融/龙虎榜/资金流 —— 暂时都是 null（历史数据脚本在后台拉，拉完后再注入）
    northAmount: null,
    marginRatio: null,
    marginBuy: null,
    shortBalance: null,
    hotSeatCount: null,
    hotNetBuy: null,
    mainFlow: null,
    sectorFlow: null,
    newsTone: null,
    annCount: null,
    // 事件数据的时间口径：默认查 t 日（盘后公布、t+1 开盘前可得，见 EXT_LAG 注释）；
    // BT_EXT_LAG=1 时严格滞后一根 K 线，只查更早那根 bar 的日期。
    // 用 K 线自身的日期查 ext（ext 按日历日索引），停牌跳日也自然对得上。
    ...injectExt(ext, extDate, id, amountWan),
    // 历史 PE/PB（baostock 真实逐日序列）。null 不是 0：null 是「那天没这个数」，
    // 策略函数应该把 null 当「无法确认便宜」处理，不能当「便宜」通过。
    // pe-history 按纯 6 位代码命名（pe-600000.json），kline 的 id 带 sh/sz 前缀，
    // 查之前先把 id 归一化成 6 位，否则键对不上 PE/PB 永远取不到。
    pe: peMap[id.replace(/[^0-9]/g, "")]?.get(rows[i].date)?.peTTM ?? null,
    pb: peMap[id.replace(/[^0-9]/g, "")]?.get(rows[i].date)?.pbMRQ ?? null,
    isST: peMap[id.replace(/[^0-9]/g, "")]?.get(rows[i].date)?.isST ?? null,
    // 总市值快照（今日，亿），cap.json 按 sh/sz+6位 命名，和 id 同格式。
    // null 不是 0：拿不到市值时策略函数应排除而非放行。
    cap: capMap[id] ?? null,
  };
}

/** 外部数据表：回测入口预加载，传给 metrics() 注入北向/两融/龙虎榜字段。
 *  外层 Map 是 date → 内层 Map 是 stockId → 各字段的值。均为 null 安全。 */
type ExtData = Map<string, Map<string, {
  hotSeatCount?: number;
  hotNetBuy?: number;
  marginRatio?: number;
  marginBuy?: number;
  /** 融券余额（元）。两融源数据里有 rqye 字段，2026-11-05 接上（见下）。 */
  shortBalance?: number;
  /** 主力净流入（原始金额，元）。横截面用比率版，见 injectExt 里的换算。 */
  mainFlowRaw?: number;
  /** 所属板块的主力净流入占比（%）。东财板块资金流，见 fetch-sector-flow.py。 */
  sectorFlow?: number;
  /** 当日公告条数（巨潮资讯，见 fetch-ann-count.py）。 */
  annCount?: number;
}>>;

function lookupExt(ext: ExtData | null | undefined, date: string, id: string) {
  if (!ext) return {};
  const day = ext.get(date);
  if (!day) return {};
  return day.get(id) ?? {};
}

function injectExt(ext: ExtData | null | undefined, date: string, id: string, amountWan: number | null) {
  const v = lookupExt(ext, date, id);
  return {
    hotSeatCount: v.hotSeatCount ?? null,
    hotNetBuy: v.hotNetBuy ?? null,
    marginRatio: v.marginRatio ?? null,
    marginBuy: v.marginBuy ?? null,
    shortBalance: v.shortBalance ?? null,
    // 主力净流入：原始金额 ÷ 当日成交额（万元 → 元）= 占比 %。横截面可比。
    mainFlow:
      v.mainFlowRaw != null && amountWan != null && amountWan > 0
        ? (v.mainFlowRaw / (amountWan * 1e4)) * 100
        : null,
    sectorFlow: v.sectorFlow ?? null,
    annCount: v.annCount ?? null,
  };
}

function avg(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/** 样本标准差（n-1）。少于 2 个样本时返回 null。 */
function stdOf(list: number[]): number | null {
  if (list.length < 2) return null;
  const m = avg(list);
  return Math.sqrt(list.reduce((s, v) => s + (v - m) ** 2, 0) / (list.length - 1));
}

/**
 * 到第 end 天为止、往回 count 个交易日的日收益率（%）。
 * 只用到 <= end 的数据，无前视。
 */
function retSeries(rows: Row[], end: number, count: number): number[] {
  const out: number[] = [];
  for (let k = end - count + 1; k <= end; k += 1) {
    if (k - 1 < 0 || rows[k - 1].c <= 0) continue;
    out.push((rows[k].c / rows[k - 1].c - 1) * 100);
  }
  return out;
}

/** 读目录：不存在返回空数组（不抛错中断回测）。 */
async function readDirSafe(dir: string): Promise<string[]> {
  try { const { readdir } = await import("node:fs/promises"); return readdir(dir); } catch { return []; }
}

/** Pearson 相关系数。数据不足 2 组或分母为 0 时返回 null。 */
function corrOf(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const mx = avg(xs);
  const my = avg(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

type Signal = { buy: number; stop: number; sell: number; score: number; atClose?: boolean; /** 成交方向：stop=追涨（现价>=buy），limit=等回踩（现价<=buy）。缺省 limit。 */ fill?: "stop" | "limit" };

/**
 * 事件数据的时间口径开关（#148）。
 *
 * 两融余额、龙虎榜都是**盘后才公布**的：t 日 15:00 收盘那一刻拿不到，
 * 但 t+1 开盘前拿得到。回测是「t 日收盘出信号、t+1 成交」，所以用 t 日事件
 * 数据是合法的（信号生成时点＝t 日盘后数据齐了之后），**但必须写明，不能默认藏着**。
 *
 * BT_EXT_LAG=1 则严格滞后一根 K 线：t 日只准看 t-1 的事件，多留一天缓冲，
 * 绝对无争议。两种口径都跑，结论若只在其中一种成立，就是靠前视撑着，不算数。
 * 默认 0（保持历史因子判决口径不变，历史 1390 行可比）。
 */
const EXT_LAG = process.env.BT_EXT_LAG === "1";

/**
 * #148 事件驱动策略：**选股条件完全由事件字段触发，不看任何价格形态**。
 * 不用 d5/d20/volRatio/chg/均线那套形态条件，只认两融异动与龙虎榜净买卖。
 * 执行骨架统一（昨收限价买、−8% 止损、+10% 止盈），所以各策略之间比的
 * 是「哪个事件有选股能力」，不是执行参数调得巧。
 *
 * 字段缺失一律 return null —— 「拿不到 ≠ 没有」，不能拿 0 顶替。
 * 只在 BT_EVENT=1 注册（和 BT_GEN2/BT_VALUE 一样的实验开关约定），
 * 默认不注册，免得污染日常基线和页面读的 runs.jsonl。
 */
type EventKind = "marginSurge" | "marginExit" | "shortHigh" | "lhbSell" | "lhbBuy" | "limitUp" | "limitUp10" | "streak1" | "streak2" | "streak3";

function eventStrategy(kind: EventKind) {
  return (m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null => {
    // 这两条不是形态条件，只是排除不可交易的票（仙股、没成交额）
    if (m.c < 4 || m.amountWan == null || m.amountWan < 3000) return null;
    // 涨停判定按板：创业/科创 20%、北交 30%、ST 5%、其余 10%；贴板 0.15 容差含一字。
    const boardLim = id && (id.startsWith("sh688") || id.startsWith("sz300")) ? 20 : id && id.startsWith("bj") ? 30 : 10;
    const isLimitUp = m.chg != null && m.chg >= (m.isST ? 5 : boardLim) - 0.15;
    const amountYuan = m.amountWan * 1e4;
    // 融资净买入占当日成交额比（横截面可比，避免大盘股金额天然大）
    const marginRatioFlow = m.marginBuy == null ? null : m.marginBuy / m.amountWan;
    // 融券余额 / 当日成交额
    const shortRatio = m.shortBalance == null ? null : m.shortBalance / amountYuan;
    let score: number | null = null;
    switch (kind) {
      case "marginSurge": // 融资大幅净买入 → 看多情绪
        if (marginRatioFlow == null || marginRatioFlow < 0.03) return null;
        score = marginRatioFlow;
        break;
      case "marginExit": // 融资大幅净偿还 → 反向假设
        if (marginRatioFlow == null || marginRatioFlow > -0.03) return null;
        score = -marginRatioFlow;
        break;
      case "shortHigh": // 融券余额相对成交额高 → 轧空假设
        if (shortRatio == null || shortRatio < 0.5) return null;
        score = shortRatio;
        break;
      case "lhbSell": // 龙虎榜净卖（游资净买的镜像，正向假设）
        if (m.hotNetBuy == null || m.hotNetBuy > -3000) return null;
        score = -m.hotNetBuy;
        break;
      case "lhbBuy": // 龙虎榜净买（已知反向信号，作负对照）
        if (m.hotNetBuy == null || m.hotNetBuy < 3000) return null;
        score = m.hotNetBuy;
        break;
      // 打板的核心赌注（2026-11-09 预登记）：涨停次日还有没有溢价（连板跟随）。
      // 打板本体（盘中挂板买）日线测不了；这里测的是它的前提——涨停封板的票，
      // 后面几天是继续强还是回吐。两种持有口径：2 天（打板短翻）/ 10 天（与其余事件同口径）。
      case "limitUp":
      case "limitUp10":
        if (!isLimitUp) return null;
        score = m.chg ?? 0;
        break;
      // 连板阶梯（2026-11-09 用户问「热点连板」）：涨停拆成首板/2连板/3+连板，
      // 龙头连板和散户追首板不是一回事，混着平均会把两头都埋掉。
      case "streak1":
      case "streak2":
      case "streak3": {
        if (!isLimitUp) return null;
        const f = slowFacOf(id, m.date);
        const s = f?.limitStreak ?? 0;
        const want = kind === "streak1" ? 1 : kind === "streak2" ? 2 : 3;
        if (kind === "streak2" ? s !== 2 : kind === "streak3" ? s < 3 : s !== 1) return null;
        score = s;
        break;
      }
    }
    if (score == null) return null;
    const buy = m.prev;
    return { buy, stop: buy * 0.92, sell: buy * 1.1, score };
  };
}

const EVENT_STRATEGIES: Record<string, { label: string; fn: StrategyFn; hold: number }> = {
  "evt-margin-surge": { label: "事件·融资净买异动", fn: eventStrategy("marginSurge"), hold: 10 },
  "evt-margin-exit": { label: "事件·融资净偿还", fn: eventStrategy("marginExit"), hold: 10 },
  "evt-short-high": { label: "事件·融券余额高", fn: eventStrategy("shortHigh"), hold: 10 },
  "evt-lhb-sell": { label: "事件·龙虎榜净卖", fn: eventStrategy("lhbSell"), hold: 10 },
  "evt-lhb-buy": { label: "事件·龙虎榜净买(负对照)", fn: eventStrategy("lhbBuy"), hold: 10 },
  "evt-limitUp": { label: "事件·涨停次日(持2)", fn: eventStrategy("limitUp"), hold: 2 },
  "evt-limitUp10": { label: "事件·涨停次日(持10)", fn: eventStrategy("limitUp10"), hold: 10 },
  "evt-streak1": { label: "事件·首板次日", fn: eventStrategy("streak1"), hold: 2 },
  "evt-streak2": { label: "事件·二连板次日", fn: eventStrategy("streak2"), hold: 2 },
  "evt-streak3": { label: "事件·三连板次日(妖股)", fn: eventStrategy("streak3"), hold: 2 },
};

// ── 短线热点家族（2026-11-09 深夜，用户核心诉求「浪里上车」）────────────────
// **不在 eventStrategy 里**：事件族有纯度纪律（只看事件字段、不看价格形态，
// eval-event.test.mjs 钉着）——题材策略是「事件 + 形态」的混合体，自立门庭。
// 题材已烧（所属概念板当日 ≥3 只涨停）为前提，两个上车姿势都不碰「追已涨停」：
//   themeLaggard   买板块里还没动的成员（近 20 日 <5%），赌浪拍到它头上；
//   themeLeaderDip 买板块内近 20 日强者（≥10%）的当日收阴回踩，赌强者第二腿。
// 执行骨架同事件族（昨收限价 · −8% / +10% · 持 5 天）。判决：两死一平
// （补涨 +0.06% 噪声、回踩 −0.70%/t=−4.5 死），战报 report-220335。
function themeLaggard(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (m.c < 4 || m.amountWan == null || m.amountWan < 3000) return null;
  if (themeHotOf(id, m.date) < 3) return null; // 题材没烧
  const lim = id && (id.startsWith("sh688") || id.startsWith("sz300")) ? 20 : id && id.startsWith("bj") ? 30 : 10;
  if (m.chg != null && m.chg >= (m.isST ? 5 : lim) - 0.15) return null; // 已涨停的不追
  if (m.d20 == null || m.d20 >= 5) return null; // 还没动
  const buy = m.prev;
  return { buy, stop: buy * 0.92, sell: buy * 1.1, score: themeHotOf(id, m.date) };
}

function themeLeaderDip(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  if (m.c < 4 || m.amountWan == null || m.amountWan < 3000) return null;
  if (themeHotOf(id, m.date) < 3) return null;
  const lim = id && (id.startsWith("sh688") || id.startsWith("sz300")) ? 20 : id && id.startsWith("bj") ? 30 : 10;
  if (m.chg != null && m.chg >= (m.isST ? 5 : lim) - 0.15) return null;
  if (m.d20 == null || m.d20 < 10) return null; // 板内强者
  if (m.chg == null || m.chg > 0) return null; // 今天回踩收阴
  const buy = m.prev;
  return { buy, stop: buy * 0.92, sell: buy * 1.1, score: m.d20 };
}

const THEME_STRATEGIES: Record<string, { label: string; fn: StrategyFn; hold: number }> = {
  "evt-themeLaggard": { label: "热点·题材补涨", fn: themeLaggard, hold: 5 },
  "evt-themeLeaderDip": { label: "热点·龙头回踩", fn: themeLeaderDip, hold: 5 },
};

// ── ML 截面对照实验（2026-11-10 预登记，design/quantmind-borrow-list.md P0-1）────
// 学界标准打法当对照组：价量特征 → GBDT → 每日截面打分取 Top-N，回答「手写规则
// 之外有没有系统性 alpha」。分数由 scripts/ml-cross-section.py 滚动训练产出
// （data/ml-scores.json，只存每日 top-50：runPass 每天最多买 MAX_POSITIONS=10，
// 第 51 名永远轮不上，存了也白存）。执行骨架与各家族统一（昨收限价 · −8% / +10% ·
// 持 8 天），判决走 eval-robust 六切片，不另设判决口径。
// 跑法：BT_ML=1 BT_ONLY=mlTop BT_WINDOW=750 BT_NO_LOG=1。
let mlScoreMap: Map<string, Map<string, number>> | null = null;
let mlBottomMap: Map<string, Set<string>> | null = null;
function loadMlScores(): boolean {
  if (mlScoreMap) return true;
  mlScoreMap = new Map();
  mlBottomMap = new Map();
  try {
    const raw = JSON.parse(readFileSync(`${DATA_DIR}/ml-scores.json`, "utf8")) as {
      days: Record<string, [string, number][]>;
      bottom?: Record<string, [string, number][]>;
    };
    for (const [d, list] of Object.entries(raw.days)) {
      const m = new Map<string, number>();
      for (const [sid, s] of list) m.set(sid, s);
      mlScoreMap.set(d, m);
    }
    for (const [d, list] of Object.entries(raw.bottom ?? {})) {
      mlBottomMap.set(d, new Set(list.map(([sid]) => sid)));
    }
  } catch {
    return false; // 分数文件没有 = 这家族没数据，不硬跑
  }
  return true;
}
function mlScoreOf(id: string, date: string): number | null {
  if (!loadMlScores()) return null;
  return mlScoreMap!.get(date)?.get(id) ?? null;
}
/** 当日模型最不看好的 bottom-50 里有没有这只票（排除器 A/B 用，DECISIONS 预登记）。 */
function mlBottomHit(id: string, date: string): boolean {
  if (!loadMlScores()) return false;
  return mlBottomMap!.get(date)?.has(id) ?? false;
}

function mlTop(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  const s = mlScoreOf(id ?? "", m.date);
  if (s == null) return null;
  const buy = m.prev;
  return { buy, stop: buy * 0.92, sell: buy * 1.1, score: s };
}

// ── ML 排除器 A/B（2026-11-10 预登记，DECISIONS 当日条目）──────────────────
// P0-1 判 Top-10 稳定负超额但 rank IC +0.065：反着用它——低估值候选剔掉当日模型
// 最不看好的 50 只，其余一字不动，和 value 原版同台对照。判读规则先写死在
// DECISIONS（差 ≥+0.3pp/笔才算有效）。跑法：
// BT_VALUE=1 BT_MLEXCL=1 BT_ONLY=value,valueMlExcl BT_WINDOW=750 BT_NO_LOG=1。
const valueMlExcl: StrategyFn = (m, stopPct, id) => {
  if (id && mlBottomHit(id, m.date)) return null;
  return valueBacktest(m, stopPct, id);
};

/** 趋势回踩：20 日涨 10%~40%，60 日至少 5%，今天跌 0~4%，买在昨收。 */
function trend(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d20 == null || m.d60 == null) return null;
  if (m.d20 < 10 || m.d20 > 40 || m.d60 < 5) return null;
  if (m.chg > 1 || m.chg < -4) return null;
  if (m.amountWan < 5000 || m.volRatio < 0.8) return null;
  if (m.c < 4) return null;
  const buy = m.prev;
  const give = stopPct ?? Math.max(3, m.d20 * 0.25);
  const stop = buy * (1 - give / 100);
  const sell = buy * (1 + Math.max(40 - m.d20, give) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.d20 };
}

/** 放量突破：量比至少 1.8，买在昨收上方 2%，止损放昨收。 */
function breakout(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  if (m.volRatio < 1.8) return null;
  if (m.amountWan < 8000) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 20) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  if (m.c < 4) return null;
  // 线上要求换手率 ≥ 2%，这道闸以前回测里没有（见文件头「已知对不上的地方」）。
  // 现在流通市值能反推了，补上。三态见 metrics 的注释：闸关时完全不卡。
  if (m.turnoverGateOn && (m.turnover == null || m.turnover < 2)) return null;
  const buy = m.prev * 1.02;
  const stop = stopPct == null ? m.prev : buy * (1 - stopPct / 100);
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10, fill: "stop" };
}

/** 启动前期：今天涨 1%~4.5%，买在涨幅中位，止损按涨幅上限。 */
function early(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  if (m.chg < 1 || m.chg > 4.5) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < -3 || m.d20 > 12 || m.d60 < -10 || m.d60 > 25) return null;
  if (m.volRatio < 1.2 || m.volRatio > 2.8) return null;
  if (m.amountWan < 5000 || m.c < 4) return null;
  const buy = m.prev * (1 + 2.75 / 100);
  const room = 12 - m.d20;
  const targetPct = Math.max(room, 4.5);
  const stop = Math.min(buy * (1 - (stopPct ?? 4.5) / 100), m.prev * (1 + 1 / 100));
  const sell = buy * (1 + targetPct / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.d20 };
}

/**
 * 缩量超跌反转（新策略）。
 * 依据：A 股日内收益对未来呈反转效应，且短周期下更强；低换手/缩量的票更被忽视。
 * 条件全部只用已知信息：连跌、缩量、没进入长期下降通道。
 */
function reversal(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  // 5 日跌 5%~12%：跌到位但没崩
  if (m.d5 > -5 || m.d5 < -12) return null;
  // 抛压衰竭：近 5 日均量不足 20 日均量的七成
  if (m.volShrink > 0.7) return null;
  // 不是长期阴跌
  if (m.d60 < -20) return null;
  // 当天已经反弹太多就不追
  if (m.chg > 3 || m.chg < -3) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;
  const buy = m.prev * 0.99;
  const stop = buy * (1 - (stopPct ?? 6) / 100);
  const sell = buy * 1.08;
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: -m.d5 };
}

/**
 * 放量突破的三个变体。原版已经是最稳的一个，这里试着更早介入、以及
 * 排除「天量出货」——单日量比过大往往是资金出逃而不是进攻。
 */
function breakout2(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  if (m.volRatio < 1.8) return null;
  if (m.amountWan < 8000 || m.c < 4) return null;
  // 更早期：20 日涨幅压到 10% 以内，避免追已经走远的票
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 10) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  const buy = m.prev * 1.02;
  const stop = stopPct == null ? m.prev : buy * (1 - stopPct / 100);
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10, fill: "stop" };
}

function breakout3(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  // 量比设上限：超过 5 倍是天量，多半是出货，不接
  if (m.volRatio < 1.8 || m.volRatio > 5) return null;
  if (m.amountWan < 8000 || m.c < 4) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 20) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  const buy = m.prev * 1.02;
  const stop = stopPct == null ? m.prev : buy * (1 - stopPct / 100);
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10, fill: "stop" };
}

function breakout4(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  if (m.volRatio < 1.8 || m.volRatio > 5) return null;
  if (m.amountWan < 8000 || m.c < 4) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 10) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  const buy = m.prev * 1.02;
  const stop = stopPct == null ? m.prev : buy * (1 - stopPct / 100);
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10, fill: "stop" };
}

/**
 * 二代线上口径的可回测近似（2026-11-05 补，判决见
 * data/backtest/2026-11-05/REPORT-GEN2-VERDICT.md）。
 *
 * 和 bk4 只差一道闸：线上 breakoutOrder 有 `quote.turnover < 2` 过滤，
 * 白皮书 §3.1 写「选股条件等于回测 bk4 口径」时把这道闸漏了。
 * bk4 保持原样不改——10-28 及更早的基线数字必须还能对得上，不能让口径偷偷漂移。
 *
 * 仍然对不齐、而且日线回测补不了的两处（报告里要明说，别拿这个数冒充线上）：
 *   ① 线上盘中限价带 hit ∈ [buy, buy×1.015]（现价刚过买入价才买，冲远了不追），
 *      要分钟数据；回测是 t+1 按日线限价单撮合。
 *   ② 线上按分钟轮询判断「此刻正在这个价」，回测按日线当天是否触及。
 * 这两条决定 gen2 只是「能对齐的部分对齐了」的判决口径，不是线上逐字复刻。
 */
function breakoutGen2(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null) return null;
  if (m.volRatio < 1.8 || m.volRatio > 5) return null;
  if (m.amountWan < 8000 || m.c < 4) return null;
  if (m.d5 < 0 || m.d5 > 8 || m.d20 < 0 || m.d20 > 10) return null;
  if (m.chg < 0 || m.chg > 7) return null;
  if (m.turnoverGateOn && (m.turnover == null || m.turnover < 2)) return null;
  const buy = m.prev * 1.02;
  const stop = stopPct == null ? m.prev : buy * (1 - stopPct / 100);
  const sell = buy * (1 + Math.max(20 - m.d20, 2) / 100);
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: m.volRatio * 10, fill: "stop" };
}

/**
 * 反转策略的改进版。原版的问题是「接飞刀」：跌了就买，可它还在跌。
 * 这一版要求当天已经出现止跌迹象——收阳、不再创新低、缩量更明显。
 * 当日收阳与否在收盘时是已知的，不违反无前视。
 */
function reversal2(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  if (m.d5 > -5 || m.d5 < -12) return null;
  if (m.volShrink > 0.7) return null;
  if (m.d60 < -20) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;
  // 止跌：当天收阳（收盘高于开盘），且收在前一日收盘之上
  if (m.c <= m.open || m.chg <= 0) return null;
  const buy = m.prev * 0.99;
  const stop = buy * (1 - (stopPct ?? 5) / 100);
  const sell = buy * 1.09;
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: -m.d5 };
}

/**
 * 威科夫 Spring 买入（候选策略，**只在回测里跑，绝不进 ACTIVE_STYLES**）。
 *
 * 进场的经济逻辑：Spring 之后需要一根 K 线确认「假跌破没有变成真跌破」——
 * 也就是收盘没有跌回 Spring 低点之下。这一天就是威科夫的 Test 阶段。
 *
 * 止损 = **Spring 那一根的最低价**，这是威科夫说的结构失效位：跌回这里说明
 * 卖压不是被吸收而是被释放，Spring 判定作废。这是本策略最干净的一条，
 * 不含任何百分比旋钮（别的策略都在拍 stopPct）。×0.99 是防「恰好买在最低价上
 * 立刻触发自己的止损」，那在实盘上等于噪声。
 *
 * ⚠️ 预注册默认值（**只标定一次**，扫参结果出来后要么采纳并重跑、要么如实记录
 * 「预注册值更差」——不许反复调）：
 *   进场时点 springAge ≥ 1（当天买实测是负的：−0.056%）
 *   持有期   BT_HOLD 扫 5/10/15/20（威科夫说 2~4 周，实测 H=15 全线转负、H=10 最优）
 */
function springBuy(m: ReturnType<typeof metrics>): Signal | null {
  if (m.springStrength == null || m.springLow == null || m.springRangeHigh == null) return null;
  // 进场时点：Spring 后第 1 天（等一根 K 线确认）。0 = 当天，实测是负的。
  const minAge = Number(process.env.BT_SPRING_AGE ?? 1);
  // 强度阈值：0 = 只要有 Spring 就买。不额外筛——强度分档已经在因子里验过，
  // 在这里再卡一刀就是双重筛选调参。
  const minStrength = Number(process.env.BT_SPRING_MIN ?? 0);
  if (m.springAge < minAge || m.springStrength < minStrength) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;

  // 这一套默认 spot（与其他策略相反）：Spring 当天已在插针底部，
  // 挂在昨收+3% 根本挂不上，那测的是另一个策略。
  const spot = (process.env.BT_BUYMODE ?? "spot") === "spot";
  const buy = spot ? m.c : m.prev * 1.03;
  const stop = m.springLow * 0.99;
  // 目标 = 威科夫量幅：区间高度从 Spring 低点量起来（SOS 的最小测算目标），
  // 比「固定 +10%」有结构依据。
  const target = m.springLow + (m.springRangeHigh - m.springLow);
  if (!(stop < buy && buy < target)) return null;
  return { buy, stop, sell: target, score: m.springStrength, atClose: spot };
}

/** 中期反转：买 60 日里跌得最惨的一批，拿 10 天。
 *
 * 这是因子检验里唯一站得住的信号，不是拍脑袋想的：60 日涨幅分五档后，
 * 未来 10 天的超额是 +0.63% / +0.30% / +0.22% / -0.16% / -0.38%（t=-2.81），
 * 而且前半段 t=-3.80、后半段 t=-1.68，两段同向、档位都单调。
 * 同期 5 日涨幅在两段里直接翻脸（-2.35 / +1.11），那种就不能用。
 *
 * 注意它说的是「跌得多所以后面反弹得快」，不是「跌得多所以便宜」——别当成价值投资。
 * 也正因为买的是连续下跌的票，退市风险、ST 风险会比别的策略高，
 * 而回测的股票池里没有已退市的票，这部分风险在回测里是看不见的。
 */
/**
 * 中期反转。
 *
 * **买价有两种口径，默认 `limit` 是老的那个，`spot` 才是线上在跑的那个**——
 * 这个开关是 2026-10-06 加的，因为发现回测和线上根本不是同一个策略：
 *
 *   limit（默认，回测口径）：挂在昨收上方 3% 的限价单。高开超过 3% 就不追。
 *        这个口径下测出来的超额是 +0.63%（t=3.62），见 data/backtest/baseline-2026-10-06.txt
 *   spot（线上口径）：按第 t 天收盘价直接买，不挂单、不追高。
 *        线上 src/lib/market/strategies.ts 的 reboundOrder 就是这个（buy = round2(quote.price)，hit 恒 true）
 *
 * 之前只测过 limit 就把数字拿去给线上背书，而线上跑的是 spot。
 * `BT_RSTOP` / `BT_RTARGET` 对应线上的 −25% 止损和 +20% 目标。
 */
function rebound(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d60 == null) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;
  // spot 口径：第 t 天收盘价就是买价，不加 3%，也不设高开过滤。
  // 成交在 t+1 开盘（下面的撮合逻辑会把 buy 当成限价单处理，
  // 开盘价高于 buy 时会判为「开在止损下方不算」——对现价单来说这个口径是保守的，
  // 因为现价单在 t 日收盘就成交了，不存在跳空。spot 的撮合修正见 exitFill 调用处的注释。
  const spot = (process.env.BT_BUYMODE ?? "limit") === "spot";
  const buy = spot ? m.c : m.prev * 1.03;
  const stop = buy * (1 - (stopPct ?? Number(process.env.BT_RSTOP ?? 8)) / 100);
  const sell = buy * (1 + Number(process.env.BT_RTARGET ?? 10) / 100);
  if (!(stop < buy && buy < sell)) return null;
  // d60 越小越优先
  return { buy, stop, sell, score: -m.d60, atClose: spot };
}

/**
 * 假设 A：流动性与质量过滤（rebound-liq5000）。
 * 预登记见 data/experiments/rebound-improve-2026-10.md——阈值在结果出来前写死：
 * 成交额 ≥ 5000 万、流通市值 ≥ 50 亿、单日换手率 ∈ [0.3%, 15%]；
 * floatCap/turnover 缓存缺失的票不入选（宁可少样本，不静默放宽）。
 * 只在 BT_REBOUND_EXP=1 时注册进 STRATEGIES，日常回测不受影响。
 */
function reboundLiq5000(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  const base = rebound(m, stopPct);
  if (!base) return null;
  if (m.amountWan < 5000) return null;
  if (m.floatCap == null || m.floatCap < 50) return null;
  if (m.turnover == null || m.turnover < 0.3 || m.turnover > 15) return null;
  return base;
}

/**
 * 假设 B：反转确认过滤（rebound-confirm5）。
 * 预登记同上：在 d60 最差候选里要求近 5 日跌幅不超过 3%（d5 > -3），
 * 过滤单边阴跌里还没止跌的票。同样只在 BT_REBOUND_EXP=1 时注册。
 */
function reboundConfirm5(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  const base = rebound(m, stopPct);
  if (!base) return null;
  if (m.d5 == null || m.d5 <= -3) return null;
  return base;
}

/** 更严的一版：除了收阳，还要求当天最低价没有跌破前一日最低价（真正企稳），且缩量更狠。 */
function reversal3(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.d5 == null || m.d20 == null || m.d60 == null) return null;
  if (m.d5 > -6 || m.d5 < -14) return null;
  if (m.volShrink > 0.55) return null;
  if (m.d60 < -15) return null;
  if (m.c < 4 || m.amountWan < 3000) return null;
  if (m.c <= m.open || m.chg <= 0) return null;
  if (m.low <= m.prevLow) return null;
  const buy = m.prev * 0.99;
  const stop = buy * (1 - (stopPct ?? 5) / 100);
  const sell = buy * 1.09;
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: -m.d5 };
}

/**
 * 低估值回测变体（value）。镜像 src/lib/market/strategies.ts 的 valueOrder：
 * PE<=18、PB<=2、d60>=-25、成交额>=3000万、流通市值>=40亿（floatCap 快照近似）。
 * 100 亿总市值门槛由 m.cap（今日快照 capMap）在策略函数内部负责（已知近似，不能当精确结论）。
 * 买卖价按 PE 锚定：min(pe,15)/pe 折算买价，目标 22 倍、止损 10 倍，夹在 +5~12% / -12~-6%。
 *
 * PE/PB 用 baostock 真实逐日序列，不是市值快照回填，所以「按当时拿得到的 PE 算买卖价」
 * 这条无前视铁律守得住。拿不到 PE/PB 的交易日直接不入选——宁可少样本，不把「未知」当「便宜」。
 */
function valueBacktest(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  if (m.isST === true) return null;
  if (m.pe == null || m.pb == null || m.pe <= 0 || m.pb <= 0) return null;
  if (m.pe > 18 || m.pb > 2) return null;
  if (m.d60 != null && m.d60 < -25) return null;
  if (m.amountWan < 3000) return null;
  if (m.c < 4) return null;
  // 总市值>=100亿：价值策略的硬性门槛。用今日快照 capMap（已知近似，非历史市值）；
  // 拿不到市值（capMap 无此票）视同无法确认资格，排除而非放行。
  if (m.cap == null || m.cap < 100) return null;
  // 流通市值>=40亿：线上 tradable 硬性要求；回测用 floatCap 快照（缺失不动，不卡）
  if (m.floatCap != null && m.floatCap < 40) return null;
  const c = m.c;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const buy = r2(c * (Math.min(m.pe, 15) / m.pe));
  const entryPe = m.pe * (buy / c);
  const sell = r2(Math.max(Math.min(buy * (22 / entryPe), buy * 1.12), buy * 1.05));
  const stop = r2(Math.min(Math.max(buy * (10 / entryPe), buy * 0.88), buy * 0.94));
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: Math.round(40 - m.pe) };
}

/**
 * 相对估值分位·持续（relValPersist）—— 价值论题的「重建版」，直接吸取 value 的失败教训。
 *
 * value 失败根因：用「PE≤18 绝对阈值」= value trap（绝对便宜 ≠ 相对便宜，低 PE 常是低质量 / 下行周期）。
 * 这里改用「个股自身 PE 在过往 250 交易日的分位（pePct）」：pct≤25 = 相对自身历史便宜；
 * 并要求连续 ≥5 天低位（streak，持续性），排除单日跳便宜的假信号。这是「分位化 + 持续性」，
 * 正是把绝对阈值的坑换成相对分位。详见 buildPePctMap / pePctMap。
 *
 * 其余教训一并用上：
 *   - 质量 / 流动性闸（isST / cap / floatCap / amountWan / c）沿用 value，这些不是 value 的失败点；
 *   - 不裸赌「便宜就涨」：要求近 60 日没崩盘式下跌（d60≥−25）、近 20 日没加速下跌（d20≥−10），
 *     即「相对便宜 + 走势未恶化」双条件，规避 value trap 的「便宜继续便宜」；
 *   - 龙虎榜过热由 runPass 全局过滤器（BT_AVOID_LHB=1）剔除（上榜=游资炒作过热代理，已验证反向）。
 *
 * 评分用 −pePct：越便宜分位越低、分越高 → 引擎 top-N 取最相对便宜的。
 * 持仓 20 个交易日（区别于失败策略的 8~10 天短 horizon，测更长持有是否出 edge）。
 * 无前视：pePct 只用 ≤ 信号日的自身历史 PE。
 */
function relValPersist(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  const code = (id ?? "").replace(/[^0-9]/g, "");
  const pp = code ? pePctMap[code]?.get(m.date) : undefined;
  if (!pp || !isFinite(pp.pct)) return null;
  if (pp.pct > 25) return null; // 不在「相对自身历史便宜」区间
  if (pp.streak < 5) return null; // 持续性：必须持续低位 ≥5 天，排除单日跳便宜
  if (m.isST === true) return null;
  if (m.pe == null || m.pb == null || m.pe <= 0 || m.pb <= 0) return null;
  if (m.cap == null || m.cap < 100) return null; // 100 亿市值门槛（同 value，已知近似）
  if (m.floatCap != null && m.floatCap < 40) return null;
  if (m.amountWan < 3000) return null;
  if (m.c < 4) return null;
  if (m.d60 != null && m.d60 < -25) return null; // 不在崩盘式下跌
  if (m.d20 != null && m.d20 < -10) return null; // 近期没加速下跌
  const c = m.c;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const buy = r2(c);
  const give = stopPct ?? 8;
  const stop = r2(buy * (1 - give / 100));
  const sell = r2(buy * (1 + 12 / 100));
  if (!(stop < buy && buy < sell)) return null;
  return { buy, stop, sell, score: -Math.round(pp.pct) };
}

/**
 * 「便宜 + 聪明钱」组合（2026-11-08 预登记实验）：价值锚定 × 融资净买确认 × 上榜否决。
 *
 * 论题由三块已验证的证据拼成，不是调参：
 *   1. 价值锚是唯一实盘正收益的家族，但绝对阈值版 value 是 value-trap、
 *      相对分位版 relValPersist 单独也没过稳健判决——缺的可能是「有没有钱在买」；
 *   2. 融资净买是 gen2 §3.3 实验线（事件研究 t=2.2 过 4/6），预登记路径明确写了
 *      「作为价值或突破的确认条件（非独立策略）回归测试」——本组合就是那次回归；
 *   3. 龙虎榜爆买反向（t=−3.4）当否决器，由 BT_AVOID_LHB=1 全局过滤器执行。
 *
 * 确认阈值直接用事件研究已验证的 0.03（融资净买/当日成交额），**不另挖阈值**；
 * 两个锚定版本各出一条，持有期沿用各自基座（value 8 天 / relValPersist 20 天），
 * 止损止盈全部复用基座原样——组合只加「确认」这一道，别的一个字不动。
 * 拿不到融资数据（marginBuy=null）按「拿不到 ≠ 没有」不放行。
 */
function valueConfirm(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  const sig = valueBacktest(m, stopPct);
  if (!sig) return null;
  if (m.marginBuy == null || m.amountWan == null || m.amountWan <= 0) return null;
  if (m.marginBuy / m.amountWan < 0.03) return null; // 没有融资确认 → 不买
  return sig;
}

function relValConfirm(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  const sig = relValPersist(m, stopPct, id);
  if (!sig) return null;
  if (m.marginBuy == null || m.amountWan == null || m.amountWan <= 0) return null;
  if (m.marginBuy / m.amountWan < 0.03) return null;
  return sig;
}

/** 突破版确认回归（gen2 §3.3 预登记的「价值**或突破**」另一半）：bk4 锚 × 融资确认。 */
function bkConfirm(m: ReturnType<typeof metrics>, stopPct?: number): Signal | null {
  const sig = breakout4(m, stopPct);
  if (!sig) return null;
  if (m.marginBuy == null || m.amountWan == null || m.amountWan <= 0) return null;
  if (m.marginBuy / m.amountWan < 0.03) return null;
  return sig;
}

/**
 * 过热否决器（2026-11-09 预登记，A/B 实验）：「买强稳定亏」的两侧当防御。
 *   mom120 > 0  → 近 5 个月赢家（低频家族实测六切片全负，t=−3.5）
 *   near52w ≥ 0.9 → 贴近年内新高（六切片全负，t=−4.4）
 * 任一命中即判「过热」，候选剔除。阈值是这两条信号各自本身的门闸镜像（符号/0.9），
 * 不是拟合出来的。加上 BT_AVOID_LHB=1 的上榜否决，三层防御同开。
 * A/B：trendCool/bk4Cool 和裸版 trend/bk4 同一轮、同一切片对照——
 * 防御层救没救回超额，一张矩阵里见分晓。
 */
function isOverheated(id: string | undefined, date: string): boolean {
  const f = slowFacOf(id, date);
  if (!f) return true; // 拿不到慢因子 = 没法确认没过热 → 不放行（拿不到≠没有）
  return (isFinite(f.mom120) && f.mom120 > 0) || (isFinite(f.near52w) && f.near52w >= 0.9);
}

function trendCool(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  if (isOverheated(id, m.date)) return null;
  return trend(m, stopPct);
}

function bk4Cool(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  if (isOverheated(id, m.date)) return null;
  return breakout4(m, stopPct);
}

/**
 * 校准修正版否决（2026-11-09 第二轮 A/B）：只否决**极值**过热（贴 52 周高点 ≥0.9），
 * 不再一刀切否决所有正动量。依据：第一轮 A/B 实测一刀切版把两个基础家族都弄
 * 更差了（留下的全是下跌反抽）——「买强亏」是**动量榜顶端**的现象（分位式），
 * 不是「凡有涨幅」的现象。near52w ≥0.9 本身就是极值门闸，镜像否决校准是对的。
 */
function near52wVeto(id: string | undefined, date: string): boolean {
  const f = slowFacOf(id, date);
  if (!f) return true;
  return isFinite(f.near52w) && f.near52w >= 0.9;
}

function trendNear(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  if (near52wVeto(id, m.date)) return null;
  return trend(m, stopPct);
}

function bk4Near(m: ReturnType<typeof metrics>, stopPct?: number, id?: string): Signal | null {
  if (near52wVeto(id, m.date)) return null;
  return breakout4(m, stopPct);
}

/**
 * 「绝望底仓」（2026-11-09 预登记，来自圣阳/九阳 2026 两只 60 日 +170~190% 大牛的案例逆向）：
 *
 * 案例事实（data/study-despair-base-20261109.json 附件口径）：
 *   - 两只启动时**距 250 日高点 −28%/−29%**、上一个大高点在 8~10 个月前、
 *     起涨前 60 天横盘微跌（漂移 −15%/−8%）、距底 +17%/+55%、启动市值 59~68 亿；
 *   - **启动日都是无量阴跌日**（−2.6%/−3.1%，量比 1.0x）——点火不可预测，
 *     可捕捉的只有「点火前的状态」，所以逻辑是「在状态里等」的低频篮子：
 *     买进处于该状态的票，持有够久（120 个交易日）让少数几只火箭付清棺材钱。
 *
 * 状态（宽口径，可检验版）：深跌（near52w ≤ 0.75）+ 旧高点（highAge ≥ 120）+
 *   横盘（d60 ∈ [−25, 10]）+ 离底（loRatio ≥ 1.03）+ 中盘（30~300 亿，今日快照，
 *   已知近似）+ 交易性闸（非 ST / ≥4 元 / 成交额 ≥3000 万）。
 * 两个变体：
 *   despairBase —— 纯状态入篮（等点火）；
 *   despairPop  —— 状态 + 首次站上 20 日高（今天收在 20 日高点上，第一缕活气才进）。
 * 执行骨架：昨收限价 · 止损 −10% · 止盈 +25% · 持有 120 个交易日（低频）。
 * 判决用宽口径；两只案例的收紧包络只用于观察名单，不当回测口径（防过拟合）。
 */
function despairState(m: ReturnType<typeof metrics>, id?: string): SlowFac | null {
  if (!slowGates(m)) return null;
  if (m.cap == null || m.cap < 30 || m.cap > 300) return null;
  const f = slowFacOf(id, m.date);
  if (!f) return null;
  if (!isFinite(f.near52w) || f.near52w > 0.75) return null; // 深跌
  if (f.highAge < 120) return null; // 旧高点，不是刚见顶
  if (m.d60 == null || m.d60 < -25 || m.d60 > 10) return null; // 横盘微跌
  if (!isFinite(f.loRatio) || f.loRatio < 1.03) return null; // 已离底
  return f;
}

function despairBase(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  const f = despairState(m, id);
  if (!f) return null;
  const buy = m.prev;
  return { buy, stop: buy * 0.9, sell: buy * 1.25, score: (1 - f.near52w) * 100 };
}

function despairPop(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  const f = despairState(m, id);
  if (!f) return null;
  if (!isFinite(f.hi20) || f.hi20 < 1.0) return null; // 首次站上 20 日高才进
  const buy = m.prev;
  return { buy, stop: buy * 0.9, sell: buy * 1.25, score: (1 - f.near52w) * 100 };
}

/**
 * 「有资金痕迹的吸筹期」（2026-11-09 预登记，用户问「怎么发现主力建仓/吸筹」）：
 * 绝望底仓的状态 + 当日融资净买为正。逻辑：价格横着、杠杆资金却在净流入，
 * 是公开数据里最接近「有人在收集筹码」的痕迹（历史主力净流入回测拿不到，
 * 融资净买是每日可得的最接近代理）。对照绝望底仓纯状态（8 年窗口 +1.44%/t=2.19），
 * 看资金确认能不能把信号变硬。执行骨架同 despairBase（持 120 天）。
 */
function despairMargin(m: ReturnType<typeof metrics>, _stopPct?: number, id?: string): Signal | null {
  const f = despairState(m, id);
  if (!f) return null;
  if (m.marginBuy == null || m.marginBuy <= 0) return null; // 拿不到融资数据 = 不确认（拿不到≠没有）
  const buy = m.prev;
  return { buy, stop: buy * 0.9, sell: buy * 1.25, score: (1 - f.near52w) * 100 };
}

/**
 * 策略函数签名：
 *   m       = 该股在信号日（t 日）的指标行（metrics() 的产物）
 *   stopPct = 全局止损覆盖（回测扫描用）
 *   id      = 股票内部编号（带 sh/sz 前缀）。**spec 轨道需要它**：涨跌停板不同
 *             （科创/创业 20%、北交所 30%、ST 5%、主板 10%），没有 id 判不出板，
 *             会把「科创板涨 15%」错当成「贴涨停」拒掉。
 */
type StrategyFn = (m: ReturnType<typeof metrics>, stopPct?: number, id?: string) => Signal | null;

/**
 * 策略基因组轨道接进回测的入口。默认不注册（日常基线/页面账本不带它）。
 *
 * 两种跑法：
 *   BT_GENOME=1                          → 把基因组里**所有待判的候选**都注册进来
 *                                          （status = proposed / testing），一次回测判一批。
 *   BT_GENOME=1 BT_GENOME_SPEC=<id>      → 只注册指定那一条（focused 调试/单跑一条）。
 * spec 用到回测取不到的字段（inflow / ytd）→ 抛错拒跑，不换字段凑数。
 *
 * 注册进来的 key 统一是 `genome_<id>`，判决脚本按这个前缀找回来写进基因组文件。
 */
const genomeSpecId = process.env.BT_GENOME_SPEC ?? "";
const genomeSpecs: { id: string; label: string; hold: number; spec: StrategySpec }[] = [];
if (process.env.BT_GENOME === "1") {
  if (genomeSpecId) {
    const one = await loadGenomeSpec(genomeSpecId);
    genomeSpecs.push({ id: genomeSpecId, label: one.label, hold: one.hold, spec: one.spec });
  } else {
    // 全量：把所有待判的候选拉进来。判不了的（口径缺字段）跳过并说明，不静默吞。
    const { readGenome } = await import("@/lib/market/strategy-genome");
    const { specBacktestReady } = await import("@/lib/market/spec-backtest");
    const file = await readGenome();
    for (const c of file.list) {
      if (c.status !== "proposed" && c.status !== "testing") continue;
      const ready = specBacktestReady(c);
      if (!ready.ready) {
        console.log(`（跳过候选 ${c.id}：${ready.missing.join("；")}）`);
        continue;
      }
      genomeSpecs.push({ id: c.id, label: `基因组·${c.name}`, hold: c.holdDays, spec: c });
    }
  }
}
const genomeFns: Record<string, StrategyFn> = {};
for (const g of genomeSpecs) {
  const spec = g.spec;
  genomeFns[`genome_${g.id}`] = (m, _stopPct, id) =>
    specBacktestSignal(spec, m as unknown as SpecBacktestRow, id ?? "");
}

const STRATEGIES: Record<string, { label: string; fn: StrategyFn; hold?: number }> = {
  trend: { label: "趋势回踩", fn: trend },
  breakout: { label: "放量突破", fn: breakout },
  early: { label: "启动前期", fn: early },
  reversal: { label: "反转·原版", fn: reversal },
  rev2: { label: "反转·加收阳", fn: reversal2 },
  rev3: { label: "反转·企稳版", fn: reversal3 },
  bk2: { label: "突破·早期版", fn: breakout2 },
  bk3: { label: "突破·排天量", fn: breakout3 },
  bk4: { label: "突破·早期+排天量", fn: breakout4 },
  // 二代判决专用：和 bk4 只差一道线上有的换手率 ≥2% 闸。默认不注册，
  // 免得日常基线报告多一行、也免得污染页面读的 JSONL / runs.jsonl。
  // 跑法：BT_GEN2=1 BT_STOP=8 BT_NO_LOG=1（详见 2026-11-05 判决报告）。
  ...(process.env.BT_GEN2 === "1"
    ? { gen2: { label: "二代·线上对齐", fn: breakoutGen2 } }
    : {}),
  // 低估值回测变体（value）。用 baostock 真实逐日 PE/PB，镜像 valueOrder 的锚定逻辑。
  // 默认不注册：日常基线/页面账本不带它；跑法 BT_VALUE=1 BT_NO_LOG=1（100 亿门槛在
  // 策略函数内部按个股查 capMap，不走 BT_CAP 全局闸——后者会删股票触发覆盖率闸口拒绝）。
  // 100 亿总市值用今日快照 capMap（已知近似，见文件头注释，非历史市值）。
  ...(process.env.BT_VALUE === "1"
    ? { value: { label: "低估值·回测变体", fn: valueBacktest, hold: holdOf("value") } }
    : {}),
  // 持有期 A/B（2026-11-09 预登记，用户直觉驱动）：买入逻辑一字不动，只变持有期
  // （8 / 20 / 40 个交易日）。质疑点：8 天是从短炒家族继承的口径，价值重估
  // （15 倍买 → 22 倍卖）本来需要几周到几个月，8 天强制清仓等于半路下车。
  // 三条同台对照判决，赢者当执行口径候选。跑法：
  // BT_VALUE=1 BT_VAREXP=1 BT_NO_LOG=1 BT_ONLY=value,valueH20,valueH40。
  ...(process.env.BT_VAREXP === "1"
    ? {
        valueH20: { label: "低估值·持20天", fn: valueBacktest, hold: 20 },
        valueH40: { label: "低估值·持40天", fn: valueBacktest, hold: 40 },
      }
    : {}),
  // 「低估 + 不上榜」选股：在 value 变体之上叠加龙虎榜净买回避（BT_AVOID_LHB=1 的全局候选过滤器）。
  // 这是把用户实盘纪律（估值+股息兜底）和已验证的反向信号（上榜=游资炒作过热代理）合到一起——
  // 选便宜的、且近期没被爆炒过的票。本身复用 valueBacktest，回避由 runPass 的全局过滤器做。
  // 跑法：BT_VALUE_AVOID=1 BT_AVOID_LHB=1 BT_NO_LOG=1（默认关，免污染基线/页面账本）。
  ...(process.env.BT_VALUE_AVOID === "1"
    ? { valueAvoid: { label: "低估+回避上榜", fn: valueBacktest, hold: holdOf("value") } }
    : {}),
  // 相对估值分位·持续（relValPersist）：价值论题的重建版，把「PE≤18 绝对阈值」换成
  // 「个股自身 PE 历史分位 + 持续低位」，修复 value-trap 失败。默认不注册（免污染基线/页面账本）。
  // 跑法：BT_NEWSTRAT=1 BT_AVOID_LHB=1 BT_NO_LOG=1（LHB 回避默认一并开，吸取「上榜=过热反向」教训）。
  ...(process.env.BT_NEWSTRAT === "1"
    ? { relValPersist: { label: "相对估值分位·持续", fn: relValPersist, hold: 20 } }
    : {}),
  // 「便宜 + 聪明钱」组合（2026-11-08 预登记，详见函数头注释）：价值锚 × 融资净买确认。
  // 上榜否决由 BT_AVOID_LHB=1 全局过滤器执行——跑组合务必带上它，否则论题第三块缺席。
  // 跑法：BT_COMBO=1 BT_AVOID_LHB=1 BT_NO_LOG=1。
  ...(process.env.BT_COMBO === "1"
    ? {
        valueConfirm: { label: "价值×融资确认", fn: valueConfirm, hold: holdOf("value") },
        relValConfirm: { label: "相对估值×融资确认", fn: relValConfirm, hold: 20 },
        bkConfirm: { label: "突破×融资确认", fn: bkConfirm },
      }
    : {}),
  // ML 截面对照实验（2026-11-10 预登记，见 mlTop 函数头注释）。默认不注册：
  // 跑法 BT_ML=1 BT_ONLY=mlTop BT_WINDOW=750 BT_NO_LOG=1。
  ...(process.env.BT_ML === "1"
    ? { mlTop: { label: "ML截面·Top10", fn: mlTop, hold: 8 } }
    : {}),
  // ML 排除器 A/B（2026-11-10 预登记，见 valueMlExcl 函数头注释）。默认不注册：
  // 跑法 BT_VALUE=1 BT_MLEXCL=1 BT_ONLY=value,valueMlExcl。
  ...(process.env.BT_MLEXCL === "1"
    ? { valueMlExcl: { label: "低估值·剔ML最差50", fn: valueMlExcl, hold: holdOf("value") } }
    : {}),
  // 低频家族（2026-11-09 预登记，详见 buildSlowFactorMaps 头注释）：经典慢信号
  // 首次上判决台——动量/52 周高点/低波动/动量×价值，统一 40 个交易日持有、
  // 止损 −10%、止盈 +25%。跑法：BT_LOWFREQ=1 BT_AVOID_LHB=1 BT_WINDOW=750 BT_NO_LOG=1。
  ...(process.env.BT_LOWFREQ === "1"
    ? {
        mom120: { label: "动量120日", fn: mom120Buy, hold: 40 },
        mom60: { label: "动量60日", fn: mom60Buy, hold: 40 },
        near52w: { label: "52周高点", fn: near52wBuy, hold: 40 },
        lowVol: { label: "低波动120日", fn: lowVolBuy, hold: 40 },
        momValue: { label: "动量×价值", fn: momValueBuy, hold: 40 },
      }
    : {}),
  // 过热否决 A/B（2026-11-09 预登记）：裸版 trend/bk4 永远注册（对照组），
  // trendCool/bk4Cool 只在 BT_COOL=1 注册。跑法：
  // BT_COOL=1 BT_AVOID_LHB=1 BT_WINDOW=750 BT_ONLY=trend,bk4,trendCool,bk4Cool。
  ...(process.env.BT_COOL === "1"
    ? {
        trendCool: { label: "趋势回踩·过热否决", fn: trendCool },
        bk4Cool: { label: "突破·过热否决", fn: bk4Cool },
      }
    : {}),
  // 校准修正版（第二轮 A/B）：只否 52 周新高极值。跑法：
  // BT_COOL2=1 BT_AVOID_LHB=1 BT_WINDOW=750 BT_ONLY=trend,bk4,trendNear,bk4Near。
  ...(process.env.BT_COOL2 === "1"
    ? {
        trendNear: { label: "趋势回踩·新高否决", fn: trendNear },
        bk4Near: { label: "突破·新高否决", fn: bk4Near },
      }
    : {}),
  // 绝望底仓（2026-11-09 预登记，圣阳/九阳案例逆向）：深跌横盘中盘低位篮子，
  // 120 个交易日低频持有等点火。跑法：BT_DESPAIR=1 BT_WINDOW=750 BT_NO_LOG=1。
  ...(process.env.BT_DESPAIR === "1"
    ? {
        despairBase: { label: "绝望底仓·纯状态", fn: despairBase, hold: 120 },
        despairPop: { label: "绝望底仓·20日高点火", fn: despairPop, hold: 120 },
        despairMargin: { label: "绝望底仓·融资痕迹", fn: despairMargin, hold: 120 },
      }
    : {}),
  // 中期反转要拿满 10 个交易日，不是别的策略那 8 天——因子检验里 10 天的信号最强。
  // 天数查 strategies.ts 的 STYLE_HOLD（唯一定义处），不再在这里写死 10。
  rebound: { label: "中期反转", fn: rebound, hold: holdOf("rebound") },
  // 中期反转受控改进实验的 A/B 变体（rebound-improve-2026-10.md 预登记）。
  // 只在这个开关下注册：日常回测/页面账本不带它们，实验数据也不混进 runs.jsonl
  // （跑实验时另带 BT_NO_LOG=1 双保险）。
  ...(process.env.BT_REBOUND_EXP === "1"
    ? {
        "rebound-liq5000": { label: "中期反转·流动性过滤", fn: reboundLiq5000, hold: holdOf("rebound") },
        "rebound-confirm5": { label: "中期反转·止跌确认", fn: reboundConfirm5, hold: holdOf("rebound") },
      }
    : {}),
  // 威科夫 Spring。只在回测里跑 —— ACTIVE_STYLES 在 strategies.ts:274，
  // 那一行是实盘记账的唯一开关，本方案绝不碰它。
  spring: { label: "Spring·威科夫", fn: springBuy, hold: holdOf("rebound") },
  // 基因组候选（BT_GENOME=1 才注册）。这才是「失败 → 新策略」那条轨道能被判的地方：
  // spec 拿到和别的策略同口径的回测待遇，判决由 genome-verdict.ts 写回基因组文件。
  ...Object.fromEntries(
    genomeSpecs.map((g) => [`genome_${g.id}`, { label: g.label, fn: genomeFns[`genome_${g.id}`], hold: g.hold }]),
  ),
  // #148 事件驱动实验（BT_EVENT=1 才注册）。默认不注册，不污染日常基线/页面账本。
  // 跑法：BT_EVENT=1 BT_NO_LOG=1 BT_SAMPLE=2646（大样本）+ BT_HALF/BT_OFFSET（样本外/多批次）。
  ...(process.env.BT_EVENT === "1" ? EVENT_STRATEGIES : {}),
  ...(process.env.BT_EVENT === "1" ? THEME_STRATEGIES : {}),
};

type Trade = {
  id: string;
  /** 信号日（t 日收盘后选股） */
  date: string;
  /**
   * **卖出日**（收益真正落袋那天）。2026-10-14 加：日度序列和按天统计必须按它聚合，
   * 按 date（信号日）聚合会把不同平仓日的收益挤到同一天——中期反转 248 天的总累计
   * 因此算出 -139.9%，而按平均收益该是 -7.4%，差 20 倍。
   */
  exitDate: string;
  entry: number;
  exit: number;
  reason: string;
  ret: number;
  /** 同一时间段里，抽样池全体股票等权持有的收益。ret 减去它才是选股本身带来的。 */
  bench: number;
  hold: number;
  /** 来源标注（学 Vibe-Research 的 raw_ref）：决策所用 K 线的缓存文件 @ 信号日，事后复核回到原始 bar。 */
  ref: string;
};

async function main() {
  console.log("无前视回测：只用在 t 日收盘时已知的信息，t+1 日按限价单成交\n");

  // 披露段：口径不写在报告头，读者就会默认「完美口径」然后被骗。
  // 全部从本文件常量取值，改参数时披露跟着变，不许和实现漂移。
  // （学 deepseek-harness-quant 的 backtest-acceptance：数据边界必须披露。）
  console.log("披露口径：");
  console.log(`  执行：t 日收盘出信号，t+1 按限价单成交；窗口 = 最近 ${LOOKBACK} 个交易日`);
  // 披露口径不许手写。每一句都从上面的常量取 —— 以前这里写的是「未计印花税/滑点」，
  // 而 0.00102 里早就含了印花税。只要文字不再自己打字就不可能漂。
  const roundTrip = roundTripFee();
  console.log(`  手续费：佣金 ${(COMMISSION_RATE * 1e4).toFixed(1)}‱ 双边 + 过户费 ${(TRANSFER_FEE * 1e4).toFixed(1)}‱ 双边 + 印花税 ${(STAMP_TAX * 1e4).toFixed(1)}‱ 卖出单边 = 一来一回 ${(FEE * 100).toFixed(3)}%`);
  console.log(
    `  滑点：单边 ${(SLIPPAGE * 100).toFixed(2)}%，一来一回 ${(SLIPPAGE * 200).toFixed(2)}%；` +
      `这是估算不是实测（回测没有逐笔成交明细），BT_SLIPPAGE=0 可关`,
  );
  console.log(
    `  最低佣金 ¥${COMMISSION_MIN}/笔：单笔 ${(CAPITAL_PER_TRADE / 10_000).toFixed(0)} 万` +
      `（佣金 ${(CAPITAL_PER_TRADE * COMMISSION_RATE).toFixed(1)} 元）→ ${CAPITAL_PER_TRADE * COMMISSION_RATE >= COMMISSION_MIN ? "不触发" : "触发"}；` +
      `触发线是单笔 ${(COMMISSION_MIN / COMMISSION_RATE / 10_000).toFixed(0)} 万以下`,
  );
  console.log(`  合计一来一回成本 ${(roundTrip * 100).toFixed(3)}%（BT_CAPITAL 改本金）`);
  console.log(`  样本：全市场列表等距抽样 ${SAMPLE} 只（BT_SAMPLE 可改），BT_OFFSET 换互不重叠的一批`);
  console.log(`  数据：日线来自腾讯 K 线接口落盘缓存（${CACHE}），qfq 前复权；市值过滤用今天的快照非历史`);
  if (process.env.BT_EVENT === "1") {
    console.log(
      `  事件数据口径：两融/龙虎榜为盘后公布，t 日 15:00 拿不到、t+1 开盘前拿得到 → ` +
        (EXT_LAG
          ? "BT_EXT_LAG=1 严格滞后一根 K 线（t 日只查更早那根 bar 的事件，绝对无争议）"
          : "当前查 t 日事件（合法但依赖盘后数据，务必与 BT_EXT_LAG=1 对照跑一遍）"),
    );
  }
  console.log("  局限：抽样 300 只的结论外推到全市场要谨慎；回测=限价单口径，与线上现价口径有差\n");

  const uniRes = await fetch("https://qt.gtimg.cn/q=sh000001", { headers: KLINE_HEADERS });
  if (!uniRes.ok) throw new Error("连不上行情");
  void uniRes;

  // 股票池：用新浪全市场快照拿代码（东财 clist 在这台机器不通）
  const ids: string[] = [];
  // 新浪按代码升序排，bj 段会排在 sh/sz 前面，所以要多翻几页；北交所票日线太短，排除。
  // 翻页加重试 + 截断即拒跑：今天四次运行里两次死在这一步（连接超时直接抛，
  // 十分钟取数的功夫全白费）；而 !res.ok 时静默 break 更糟——会拿一个截断的池
  // 跑完基线（按代码升序，截断丢的是 sz 尾部，样本整个变形），数字看着像结论。
  // 池拿不全就不跑：诚实的失败好过假的成功。
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    let list: { symbol?: string }[] | null = null;
    for (let attempt = 0; attempt < 3 && !list; attempt += 1) {
      try {
        const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
        if (res.ok) list = (await res.json()) as { symbol?: string }[];
      } catch {
        // 超时/被挡：重试。间隔递增，给对面的限流留恢复时间。
      }
      if (!list) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (!list) {
      throw new Error(`股票池第 ${page} 页三次都没拿到，池可能被截断——不跑。基线要可复现，拿不全池子的数字不算数`);
    }
    if (list.length === 0) break;
    for (const row of list) {
      const s = row.symbol ?? "";
      if (/^(sh|sz)\d{6}$/.test(s)) ids.push(s);
    }
  }
  // 等距抽样，覆盖各个代码段。BT_OFFSET 换个起点就能拿到另一批互不重叠的票，
  // 用来检查结论是不是只在这一批样本上成立。
  const step = Math.max(1, Math.floor(ids.length / SAMPLE));
  const offset = Number(process.env.BT_OFFSET ?? 0);
  const sample = ids.filter((_, i) => (i + offset) % step === 0).slice(0, SAMPLE);
  console.log(`股票池 ${ids.length} 只，抽样 ${sample.length} 只\n`);

  // 指数先抓：一身三职——① 窗口脊（下面的 dates）② 缓存保鲜的尺子 ③ 基准。
  // 以前 klines 取完才抓指数，② 这把尺子根本用不上。
  const bench = await fetchKline("sh000300", true);
  // 窗口脊锚在指数交易日历上。以前取 klines Map 的第一只股票——4 个 worker 谁先
  // 完成谁排第一，是**非确定性**的：两次都凑巧冻在 09-30 的文件先回来，窗口才没滑；
  // 缓存一清理（另一批文件先完成）窗口就变，同代码两次跑出不同区间（10-24 基线
  // 问题①，用户已拍板修）。指数日历完整、确定，且和基准同一根轴——基准窗口跟着
  // 策略窗口走，不再各滑各的。
  const dates = bench.map((r) => r.date);
  // 保鲜尺子：最后 K 线早于脊上倒数第 3 个交易日的缓存算超龄（3 个交易日容差，
  // 停牌两三天的票不会被无意义重抓；长假也不会天天重抓——脊的末尾就是最后一个
  // 交易日，不是跑题当天的日历日）。
  const freshThrough = dates[Math.max(0, dates.length - 3)] ?? "";

  const klines = await loadKlines(sample, freshThrough);
  console.log(`取到日线 ${klines.size} 只\n`);

  // 线上 tradable 硬性要求总市值 40 亿以上，回测里没有市值字段（K 线不带），
  // 所以要单独抓一份存在本地。BT_CAP=<亿> 可以把样本按市值卡一遍，
  // 用来回答「这个效应是不是只在小票上，线上那个门槛会不会正好把它滤掉」。
  // 口径的窟窿：这里用的是今天的市值，不是历史市值，多数票两年里量级没变，
  // 只能当稳健性粗检，不能当精确结论。
  // 总市值快照（今日，亿）始终加载：value 变体的 100 亿门槛在策略函数内部按个股查，
  // 不能靠下面这个 BT_CAP 全局闸（它会删股票、把覆盖率拉到 50% 以下触发请求闸口拒绝）。
  try {
    capMap = JSON.parse(await readFile(`${CACHE}/../cap.json`, "utf8")) as Record<string, number>;
  } catch {
    console.log("（没有 cap.json，value 的 100 亿门槛与 BT_CAP 过滤都不可用；先跑 node scripts/build-caps.mjs。）\n");
  }
  const capFloor = Number(process.env.BT_CAP ?? 0);
  if (capFloor > 0) {
    let dropped = 0;
    for (const id of [...klines.keys()]) {
      const value = capMap[id];
      if (value != null && value >= capFloor) continue;
      klines.delete(id);
      dropped += 1;
    }
    console.log(`市值 ${capFloor} 亿以上：剩 ${klines.size} 只，滤掉 ${dropped} 只\n`);
  }

  // 加载外部数据注入 metrics。
  // 两融：从 data/risk/margin/*.json 构建内存查询表（带股票代码，可直接匹配）。
  // 龙虎榜：从 data/risk/hotmoney/*.json + hotmoney-names.json（名称→代码映射）构建。
  let ext: ExtData | null = null;
  let hotNames: Record<string, string> = {};
  try { hotNames = JSON.parse(await readFile(`${DATA_DIR}/risk/hotmoney-names.json`, "utf8")); } catch { /* 无映射文件跳过 */ }
  try {
    const marginDir = `${DATA_DIR}/risk/margin`;
    const hotDir = `${DATA_DIR}/risk/hotmoney`;
    ext = new Map();

    // 两融
    for (const f of await readDirSafe(marginDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(`${marginDir}/${f}`, "utf8"));
        const date = raw.date as string;
        if (!date || !Array.isArray(raw.rows)) continue;
        const day = new Map<string, any>();
        for (const row of raw.rows) {
          const code = row.id as string;
          if (!code || !/^\d{6}$/.test(code)) continue;
          const prefixed = code.startsWith("6") ? `sh${code}` : `sz${code}`;
          const cur = day.get(prefixed) ?? {};
          if (row.ratio != null) cur.marginRatio = Number(row.ratio);
          if (row.rzjme != null) cur.marginBuy = Number(row.rzjme) / 1e4;
          // 融券余额（元）。源数据里有（rqye），但这段加载器一直没读它——
          // 于是 short_balance 因子每轮都是「没测到」（t=0），白占一个注册位。
          // 2026-11-05 接上。
          if (row.rqye != null) cur.shortBalance = Number(row.rqye);
          day.set(prefixed, cur);
        }
        if (day.size > 0) ext.set(date, day);
      } catch { /* 坏文件跳过 */ }
    }

    // 龙虎榜：name → code → prefixed id
    const hotDates = 0;
    for (const f of await readDirSafe(hotDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(`${hotDir}/${f}`, "utf8"));
        const date = raw.date as string;
        if (!date || !Array.isArray(raw.seats)) continue;
        let day = ext.get(date);
        if (!day) day = new Map();
        for (const seat of raw.seats) {
          for (const stock of seat.stocks ?? []) {
            const code = hotNames[stock.name] as string | undefined;
            if (!code) continue;
            const prefixed = code.startsWith("6") ? `sh${code}` : `sz${code}`;
            const cur = day.get(prefixed) ?? {};
            cur.hotSeatCount = (cur.hotSeatCount ?? 0) + 1;
            cur.hotNetBuy = (cur.hotNetBuy ?? 0) + (stock.netWan ?? 0);
            day.set(prefixed, cur);
          }
        }
        ext.set(date, day);
      } catch { /* 坏文件跳过 */ }
    }
    // 资金流（主力净流入）：data/backtest/flow/<id>.json（东财 120 日）。
    // 口径：**主力净流入占当日成交额比**（%），不是原始金额——横截面比原始金额
    // 比的是市值规模（大盘股金额天然大），不是资金流强度。BT_FLOW 探路当时也用
    // ratio（mainRatio/mainRatio5），这里口径一致。原始金额另存在 mainFlowRaw。
    let flowLoaded = 0;
    for (const id of klines.keys()) {
      try {
        const rows = JSON.parse(await readFile(`${CACHE}/../flow/${id}.json`, "utf8")) as { date: string; main: number }[];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (const r of rows) {
          if (!r?.date || r.main == null) continue;
          const day = ext.get(r.date) ?? new Map();
          const cur = day.get(id) ?? {};
          cur.mainFlowRaw = Number(r.main);
          day.set(id, cur);
          ext.set(r.date, day);
        }
        flowLoaded += 1;
      } catch {
        // 没拉到缓存，跳过（那只票这天就是 null）
      }
    }
    // 板块资金流（所属板块主力净流入占比 %）：data/backtest/sector-flow/<BK>.json。
    // 每个板块一份（日期→占比 + 今天的成分股），按成分股摊到个股上。
    // ⚠️ 成分股是**抓取当天**的快照，历史回放也用它 → 分类前视（板块资金流本身是
    // 真实历史，没前视）。这条局限写在因子注册表的 rationale 里。
    let sectorLoaded = 0;
    let sectorMembers = 0;
    for (const f of await readDirSafe(`${CACHE}/../sector-flow`)) {
      if (!f.endsWith(".json") || f === "sectors.json") continue;
      try {
        const raw = JSON.parse(await readFile(`${CACHE}/../sector-flow/${f}`, "utf8")) as {
          days?: { date: string; mainRatio: number }[];
          members?: string[];
        };
        if (!Array.isArray(raw.days) || !Array.isArray(raw.members)) continue;
        for (const d of raw.days) {
          if (!d?.date || d.mainRatio == null) continue;
          const day = ext.get(d.date) ?? new Map();
          for (const id of raw.members) {
            const cur = day.get(id) ?? {};
            // 一只票可能属于多个行业板块 → 取绝对值最大的那个（信号最强的那条线）
            if (cur.sectorFlow == null || Math.abs(d.mainRatio) > Math.abs(cur.sectorFlow)) {
              cur.sectorFlow = d.mainRatio;
            }
            day.set(id, cur);
          }
          ext.set(d.date, day);
        }
        sectorLoaded += 1;
        sectorMembers += raw.members.length;
      } catch {
        // 坏文件跳过
      }
    }
    // 公告密度：data/backtest/ann/<日期>.json = { date, counts: { 6位代码: 条数 } }。
    let annDays = 0;
    for (const f of await readDirSafe(`${CACHE}/../ann`)) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await readFile(`${CACHE}/../ann/${f}`, "utf8")) as {
          date?: string;
          counts?: Record<string, number>;
        };
        if (!raw.date || !raw.counts) continue;
        const day = ext.get(raw.date) ?? new Map();
        for (const [code, n] of Object.entries(raw.counts)) {
          if (!n) continue;
          const id = code.startsWith("6") ? `sh${code}` : code.startsWith("9") || code.startsWith("4") || code.startsWith("8") ? `bj${code}` : `sz${code}`;
          const cur = day.get(id) ?? {};
          cur.annCount = n;
          day.set(id, cur);
        }
        ext.set(raw.date, day);
        annDays += 1;
      } catch {
        // 坏文件跳过
      }
    }
    console.log(
      `外部数据加载：${ext.size} 个交易日（资金流缓存命中 ${flowLoaded} 只，` +
        `板块资金流 ${sectorLoaded} 个板块/${sectorMembers} 只成分股，公告 ${annDays} 天）\n`,
    );
  } catch { ext = null; }

  // 日期 -> 该票在自己数组里的下标。主循环里天天 findIndex 太慢，顺手也为了算基准。
  const idxOf = new Map<string, Map<string, number>>();
  for (const [id, rows] of klines) {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.date, i));
    idxOf.set(id, map);
  }

  // 基准按策略窗口起止切片。以前是「抓最近 250 根算指数收益」——窗口随跑动日期滑，
  // 和策略窗口（冻在缓存里）不同期：10-12 那轮 -5.1%、10-24 这轮 -9.6% 是这么来的，
  // 不是行情变了（10-24 基线问题③，用户已拍板修）。现在脊就是指数，同一起止。
  const startIdx = Math.max(0, dates.length - WINDOW);
  const endDate = dates[dates.length - 1] ?? "";
  const startDate = dates[startIdx] ?? "";
  const benchStart = bench[startIdx]?.c ?? null;
  const benchEnd = bench[bench.length - 1]?.c ?? null;
  const benchRet = benchStart && benchEnd ? (benchEnd - benchStart) / benchStart : 0;

  // 逐日推进：t 日收盘后选股，t+1 日成交
  console.log(`回测区间 ${startDate} ~ ${endDate}（${dates.length - startIdx} 个交易日）\n`);

  // 同期「抽样池全体等权」的日收益。沪深 300 只能说明大盘怎么样，说明不了
  // 这批活跃票本身涨没涨。有了它，每笔交易都能算出「同一时间随便买一只的平均结果」，
  // 两者相减才是选股挑出来的那部分。
  const uniRet = new Float64Array(dates.length);
  for (let i = 1; i < dates.length; i += 1) {
    let sum = 0;
    let n = 0;
    for (const [id, rows] of klines) {
      const pos = idxOf.get(id);
      if (!pos) continue;
      const a = pos.get(dates[i - 1]);
      const b = pos.get(dates[i]);
      if (a == null || b == null) continue;
      const from = rows[a].c;
      const to = rows[b].c;
      if (from > 0 && to > 0) {
        sum += to / from - 1;
        n += 1;
      }
    }
    uniRet[i] = n > 0 ? sum / n : 0;
  }
  const datePos = new Map<string, number>();
  dates.forEach((d, i) => datePos.set(d, i));
  /** 从入场那天到出场那天，全池等权能拿到的收益。 */
  /**
   * 基准也要付交易成本。
   *
   * 以前这里只累加全池等权收益、一分钱成本不扣，而策略那侧扣了——**双方不同口径，
   * 超额被系统性低估一个往返成本**（2026-10-12 加滑点时发现：策略平均收益掉 0.20%，
   * 基准纹丝不动，t 从 3.10 掉到 1.97，看着像滑点把结论打没了，其实是基准在占便宜）。
   * 基准是等权买入、持有、卖出，和策略付同样一次来回。同口径才叫对照。
   */
  function benchOver(fromIdx: number, toIdx: number, fee: number = roundTripFee()): number {
    let acc = 1;
    for (let i = fromIdx + 1; i <= toIdx && i < uniRet.length; i += 1) acc *= 1 + uniRet[i];
    return acc - 1 - fee;
  }

  // 环境总闸：沪深 300 在 20 日均线下方时，认为逆风，当天不开新仓
  const useFilter = process.env.BT_FILTER === "1";

  // 龙虎榜净买回避过滤器（游资/营业部驱动的反向信号）：实盘闸门默认关，本回测需显式开 BT_AVOID_LHB=1。
  // 多头候选若近期（窗口 BT_AVOID_WIN **自然日**，默认 80 ≈ 55 交易日）出现在净买名单上，直接剔除。
  // 窗口调参见 scripts/backtest-avoid-window.ts；阈值 3000 万是扫过的最优值（scripts/backtest-avoid-threshold.ts）。
  // 席位拆解表明该反向 edge 由游资/营业部驱动，机构净买单独不反向。
  const useAvoid = process.env.BT_AVOID_LHB === "1";
  const AVOID_WINDOW = Number(process.env.BT_AVOID_WIN ?? 80); // 自然日；80 ≈ 55 交易日（拖累饱和点）。调参见 scripts/backtest-avoid-window.ts
  if (useAvoid) {
    await loadAvoidIndex();
    console.log(`龙虎榜回避过滤器已加载（席位口径 ${process.env.LHB_SEATS ?? "noninst"}，窗口 ${AVOID_WINDOW} 天）：近期净买名单上的票，多头候选直接剔除\n`);
  }

  // 流通市值缓存，给放量突破的换手率闸用。缺了要**大声说**，不能静默跳过那道闸——
  // 静默跳过的话，回测又会变回那个比线上宽松的版本，而报告里看不出来。
  // BT_TURNOVER=0 可以强制关掉这道闸，专门用来做 A/B 对照（改动前后差多少）。
  let floatCapMap: Record<string, number> = {};
  try {
    floatCapMap = JSON.parse(await readFile(`${CACHE}/../floatcap.json`, "utf8")) as Record<string, number>;
  } catch {
    floatCapMap = {};
  }
  await loadPeHistory();
  buildPePctMap(); // 个股自身 PE 历史分位（relValPersist 用，无前视）
  buildSlowFactorMaps(klines); // 低频慢因子（动量/52周高点/波动，BT_LOWFREQ 家族用）
  buildThemeHeatMap(klines); // 题材热度（概念板当日涨停数，热点事件族用）
  const useTurnoverGate = Object.keys(floatCapMap).length > 0 && process.env.BT_TURNOVER !== "0";
  if (useTurnoverGate) {
    console.log(`流通市值缓存 ${Object.keys(floatCapMap).length} 条，放量突破的换手率闸已启用（≥2%）\n`);
  } else if (process.env.BT_TURNOVER === "0") {
    console.log("BT_TURNOVER=0：换手率闸被强制关掉，本次结果比线上宽松，别拿它下结论。\n");
  } else {
    console.log(
      "⚠ 没有 data/backtest/floatcap.json —— 放量突破的换手率闸（线上 ≥2%）这次没生效，\n" +
        "  回测结果会偏宽松。先跑 node scripts/build-caps.mjs（不联网，读本地行情缓存）。\n",
    );
  }
  // 请求闸口（学 Vibe-Research 的 gate.py「三问闸口」）：开跑前回答样本/覆盖/预热三问，
  // 答得出来 → Plan 照跑；答不出来 → Refusal（带补救），没有带一堆警告勉强跑的第三种。
  const MIN_BARS = 62; // 引擎里 idx < 61 跳过，即至少要 62 根 bar 才进得了选股
  let sampleWithEnoughBars = 0;
  for (const rows of klines.values()) if (rows.length >= MIN_BARS) sampleWithEnoughBars += 1;
  const gate = decideGate({
    sampleRequested: SAMPLE,
    universeGot: ids.length,
    sampleGot: sample.length,
    klinesGot: klines.size,
    minBarsRequired: MIN_BARS,
    sampleWithEnoughBars,
    turnoverGateActive: useTurnoverGate,
    turnoverGateForcedOff: process.env.BT_TURNOVER === "0",
  });
  if (gate.kind === "refusal") {
    console.log("回测请求闸口：Refusal —— 这次不跑");
    console.log(`  原因：${gate.reason}`);
    console.log(`  补救：${gate.remedy}`);
    process.exit(1);
  }
  console.log("回测请求闸口：Plan");
  for (const line of gate.plan) console.log(`  · ${line}`);
  console.log("");
  // 入场撮合口径，三选一；默认 b（跳空按开盘价成交）
  const fillMode = process.env.BT_FILL ?? "b";
  let fillStats = { gap: 0, belowStop: 0 };
  /** 主结果那次 report 的指标攒这里，最后落 JSONL（页面 /backtest 读它） */
  const runStats: BacktestStyleStat[] = [];
  function bullishAt(date: string): boolean {
    const i = bench.findIndex((r) => r.date === date);
    if (i < 20) return false;
    const ma20 = avg(bench.slice(i - 19, i + 1).map((r) => r.c));
    return bench[i].c > ma20;
  }

  function runPass(stopPct?: number, fee: number = roundTripFee()): Record<string, Trade[]> {
  const results: Record<string, Trade[]> = {};
  for (const key of Object.keys(STRATEGIES)) results[key] = [];
  const stats = { gap: 0, belowStop: 0, atClose: 0, missed: 0, missByStyle: {} as Record<string, number> };

  // 样本外验证：把区间劈成前后两段分别跑，看参数是不是只在这段数据上好看
  const half = process.env.BT_HALF;
  const mid = Math.floor((startIdx + dates.length - 2) / 2);
  const from = half === "second" ? mid : startIdx;
  const to = half === "first" ? mid : dates.length - 2;

  for (let t = from; t < to; t += 1) {
    if (useFilter && !bullishAt(dates[t])) continue;
    const picks: Record<string, { id: string; sig: Signal }[]> = {};
    for (const key of Object.keys(STRATEGIES)) picks[key] = [];

    for (const [id, rows] of klines) {
      // 找到这只票在第 t 天的位置：只能用 <= t 的数据
      const idx = idxOf.get(id)?.get(dates[t]) ?? -1;
      if (idx < 61) continue;
      const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate, id, ext);
      for (const [key, def] of Object.entries(STRATEGIES)) {
        const sig = def.fn(m, stopPct, id);
        if (sig) picks[key].push({ id, sig });
      }
    }

    // 龙虎榜回避：近期净买（游资/营业部驱动的反向信号）的票，多头候选直接剔除（留着只拖后腿）
    if (useAvoid) {
      for (const key of Object.keys(picks)) {
        picks[key] = picks[key].filter((p) => !shouldAvoid(p.id, dates[t], AVOID_WINDOW));
      }
    }

    for (const [key, list] of Object.entries(picks)) {
      list.sort((a, b) => b.sig.score - a.sig.score);
      for (const pick of list.slice(0, MAX_POSITIONS)) {
        const rows = klines.get(pick.id);
        if (!rows) continue;
        const tIdx = idxOf.get(pick.id)?.get(dates[t]) ?? -1;
        const nextIdx = idxOf.get(pick.id)?.get(dates[t + 1]) ?? -1;
        if (nextIdx < 0) continue;
        const bar = rows[nextIdx];

        // 现价单（BT_BUYMODE=spot，线上口径）：第 t 天收盘就成交了。
        // 所以不走下面那套限价单撮合——它会拿 t+1 的开盘/最低价去比，
        // 对一个已经成交完的单子来说那是错的（跳空跟我无关）。
        // 持股天数也从 t 当天算起：t+1 才是第一个完整交易日。
        if (pick.sig.atClose) {
          if (tIdx < 0) continue;
          stats.atClose += 1;
          const spotFill = exitFill(
            rows as Bar[],
            rows[tIdx].date,
            pick.sig.buy,
            pick.sig.stop,
            pick.sig.sell,
            boardLimit(pick.id, ""),
            holdFor(key),
          );
          if (!spotFill) continue;
          const spotRet = (spotFill.price - pick.sig.buy) / pick.sig.buy - fee;
          const spotExitIdx = idxOf.get(pick.id)?.get(spotFill.date) ?? -1;
          results[key].push({
            id: pick.id,
            date: rows[tIdx].date,
            // 卖出日（收益落袋那天）。2026-10-24 补：518e6c3 给 Trade 加 exitDate 时
            // 只改了限价口径那处 push，spot 这处漏了——按天聚合全塌成一个 undefined 桶。
            // scripts/ 不做类型检查，所以这个漏字段跑了 10 天没人报。
            exitDate: spotFill.date,
            entry: pick.sig.buy,
            exit: spotFill.price,
            reason: spotFill.reason,
            ret: spotRet,
            // benchOver 用的是**全局日历索引**（uniRet 按 dates 建），这里的出场索引
            // 必须走 datePos.get(卖出日)，不能用 spotExitIdx —— 那是**个股行内索引**
            // （idxOf 按每只票的行号建，动辄上千）。混用会把 uniRet[t+1..上千] 当整段
            // 窗口累加，大盘基准被算成 −7.4%（10 天持有期），excess 凭空 +6.8pp。
            // 2026-11-11 修：Spring 默认 spot 口径，+17.35 的假 alpha 就是这条造的。
            bench: benchOver(t, datePos.get(spotFill.date) ?? t, fee),
            hold: Math.max(0, spotExitIdx - tIdx),
            ref: klineRef(CACHE, pick.id, rows[tIdx].date),
          });
          continue;
        }

        // 撮合。挂在 P（buy），按「买卖价 vs 信号日收盘」分方向：
        //   buy > 信号收盘 → 突破单（stop-buy，线上 hit=现价>=buy 是追涨）：
        //       次日高开越过 buy 按开盘价成交；否则盘中最高价触及 buy 按 buy 成交
        //   buy < 信号收盘 → 限价单（limit-buy，等回踩）：
        //       次日低开跌破 buy 按开盘价成交；否则盘中最低价触及 buy 按 buy 成交
        //   buy ≈ 信号收盘 → 市价口径（trend 的「买在昨收」）：按次日开盘价成交
        //
        // 2026-10-28 修：以前一律按限价单撮合，把突破单也当「等回踩」——
        // 线上 breakoutOrder.hit 是「现价 >= buy」，是追涨，方向相反，回测测的
        // 根本不是线上在跑的那笔交易。BT_FILL 三档：
        //   a = 老口径（一律按挂单价，方向对了才算碰到）
        //   b = 真实口径（跳空按开盘价成交）  ← 默认
        //   c = 只认当天价格确实穿越过 buy 的，跳空那批直接不算
        const open = bar.o > 0 ? bar.o : null;
        // 成交方向来自策略自己标注（fill 字段）：只有 breakout 家族是 stop（追涨），
        // 其余全是 limit（等回踩）。不能拿 buy 和信号收盘比大小来猜——
        // 中期反转 limit 模式 buy = 昨收×1.03 也大于收盘，但语义是「挂 +3% 不追高」，
        // 是限价不是突破。
        const isStop = pick.sig.fill === "stop";
        let entry: number | null = null;
        if (fillMode === "a") {
          if (isStop ? bar.h >= pick.sig.buy : bar.l <= pick.sig.buy) entry = pick.sig.buy;
        } else if (fillMode === "b") {
          if (isStop) {
            if (open != null && open >= pick.sig.buy) entry = open;
            else if (bar.h >= pick.sig.buy) entry = pick.sig.buy;
          } else {
            if (open != null && open <= pick.sig.buy) entry = open;
            else if (bar.l <= pick.sig.buy) entry = pick.sig.buy;
          }
        } else {
          // fillMode c：当天价格确实在 buy 这个价位成交过（盘中穿越）
          if (bar.l <= pick.sig.buy && bar.h >= pick.sig.buy) entry = pick.sig.buy;
        }
        if (entry == null) {
          // 挂价没被碰到 = 这张单根本成交不了。以前这里静默跳过，于是报告里
          // 只有「成交后的收益」，看不到「有多少信号其实是废单」。
          stats.missed += 1;
          stats.missByStyle[key] = (stats.missByStyle[key] ?? 0) + 1;
          continue;
        }
        // 跳空把价格直接开到止损下方：买是买到了，但拿到手的价已经在止损下面，
        // 这不是策略设想的那笔交易（止损会立刻被打掉，价格没法确定），干脆不算。
        if (entry <= pick.sig.stop) {
          stats.belowStop += 1;
          continue;
        }
        if (open != null && (isStop ? open >= pick.sig.buy : open <= pick.sig.buy)) stats.gap += 1;
        // 涨跌停幅度要按代码分：创业板和科创板是 20%，写死 10% 的话它们
        // 一次正常回调就会被当成「跌停封死卖不掉」跳过。
        const fill = exitFill(
          rows as Bar[],
          bar.date,
          entry,
          pick.sig.stop,
          pick.sig.sell,
          boardLimit(pick.id, ""),
          // 中期反转的持有天数可以扫（BT_HOLD），其余沿用 8 天的老规矩
          holdFor(key),
        );
        if (!fill) continue;
        const ret = (fill.price - entry) / entry - fee;
        const exitIdx = idxOf.get(pick.id)?.get(fill.date) ?? -1;
        const hold = exitIdx - nextIdx;
        results[key].push({
          id: pick.id,
          date: bar.date,
          exitDate: fill.date,
          entry,
          exit: fill.price,
          reason: fill.reason,
          ret,
          bench: benchOver(t + 1, datePos.get(fill.date) ?? t + 1, fee),
          hold,
          // 信号日是第 t 天（成交在 t+1），来源指到决策那一刻能看到的最后一根 bar
          ref: klineRef(CACHE, pick.id, dates[t]),
        });
      }
    }
  }
  fillStats = stats;
  return results;
  }

  /**
   * 打一份策略指标表到 stdout。
   *
   * `collect` 为真时顺手把指标攒进 `runStats`（页面 /backtest 读它）。
   * 只有**主结果**那次传 true：止损扫描和费用对照重跑出来的中间数字不是
   * 「一次运行的结果」，混进历史表里会把曲线搞脏。
   */
  function report(results: Record<string, Trade[]>, title: string, collect = false) {
  console.log(title);
  console.log("策略            笔数   胜率   平均收益   同期全池    超额    信噪比   跑赢   平均持有  连亏天数  回撤");
  console.log("-".repeat(110));
  for (const [key, def] of Object.entries(STRATEGIES)) {
    const trades = results[key];
    if (trades.length === 0) {
      console.log(`${def.label.padEnd(14)} 0 笔（区间内没出现符合条件的票）`);
      continue;
    }
    const wins = trades.filter((t) => t.ret > 0).length;
    const sum = trades.reduce((s, t) => s + t.ret, 0);
    const avg = sum / trades.length;
    // 同期全池等权：这些票本来就在动，减掉它才是选股挑出来的那部分
    const benchAvg = trades.reduce((s, t) => s + t.bench, 0) / trades.length;
    const alpha = avg - benchAvg;
    // 单笔超额波动很大，光看均值会自己骗自己。算个信噪比：
    // |t| 不到 2 就说明这点超额和 0 分不开，等于没测出来。
    const spread =
      trades.length > 1
        ? Math.sqrt(
            trades.reduce((s, t) => s + (t.ret - t.bench - alpha) ** 2, 0) / (trades.length - 1),
          )
        : 0;
    const tStat = spread > 0 ? alpha / (spread / Math.sqrt(trades.length)) : 0;
    const hold = trades.reduce((s, t) => s + t.hold, 0) / trades.length;
    // 连亏和回撤都按天算，和线上闸门同一口径
    let streak = 0;
    let worst = 0;
    for (const value of byDay(trades)) {
      streak = value <= 0 ? streak + 1 : 0;
      if (streak > worst) worst = streak;
    }
    const drawdown = drawdownByDay(trades);
    if (collect) {
      // 日度序列也落一份：页面的四张图（累计/回撤/月度/年度）要它。
      // 没有序列就只有汇总指标，画不出曲线——这是原来 runs.jsonl 的短板。
      // 基准序列单独存（date → 平均 bench），曲线那边按日期对齐，缺的日子不补 0。
      const dayRows = dayRowsOf(trades);
      const benchRows = benchRowsOf(trades);
      runStats.push({
        key,
        label: def.label,
        trades: trades.length,
        winRate: wins / trades.length,
        avgRet: avg,
        benchAvg,
        alpha,
        tStat,
        beatRate: trades.filter((t) => t.ret > t.bench).length / trades.length,
        avgHold: hold,
        worstStreak: worst,
        drawdown,
        daily: dayRows,
        bench: benchRows,
      });
    }
    console.log(
      def.label.padEnd(14) +
        String(trades.length).padEnd(6) +
        `${((wins / trades.length) * 100).toFixed(0)}%`.padEnd(7) +
        `${(avg * 100).toFixed(2)}%`.padStart(8) +
        `${(benchAvg * 100).toFixed(2)}%`.padStart(10) +
        `${(alpha >= 0 ? "+" : "") + (alpha * 100).toFixed(2)}%`.padStart(9) +
        tStat.toFixed(2).padStart(7) +
        `${((trades.filter((t) => t.ret > t.bench).length / trades.length) * 100).toFixed(0)}%`.padStart(7) +
        `${hold.toFixed(1)} 天`.padStart(10) +
        String(worst).padStart(9) +
        `${(drawdown * 100).toFixed(1)}%`.padStart(10),
    );
    // 两道关判定（白皮书 §4）：聚类 |t|≥2 且 前后同向，两道都过才算站住。
    // 教训：spring 在 n=60 逐笔 t=+2.08 看着能部署，n=300 直接 -0.61（小样本假阳性）。
    // 这里用信噪比（同一天平仓的票共享 beta，逐笔 t 虚高 5~7 倍）+ 前后同向，
    // 别再拿单笔 t 自己骗自己。任何新候选一律按这关判。
    const cg = clusterTOf(trades);
    const hs = halvesSameSignOf(trades);
    const v = judgeGenomeVerdict({
      ran: true,
      trades: trades.length,
      excessPp: cg ? cg.excess * 100 : null,
      clusteredT: cg ? cg.clusterT : null,
      halvesSameSign: hs,
    });
    const tStr = cg && cg.clusterT != null ? (cg.clusterT >= 0 ? "+" : "") + cg.clusterT.toFixed(2) : "算不出";
    const hsStr = hs == null ? "?" : hs ? "同向✓" : "翻脸✗";
    const verdict = v.status === "promoted" ? "过关 ✓" : v.status === "rejected" ? "没过 ✗" : "样本不足";
    console.log(`  两道关: 信噪比=${tStr} | 前后半段${hsStr} | 判定=${verdict}`);
  }
  console.log("-".repeat(110));
  }

  // 按天聚合（byDay/dayRowsOf/benchRowsOf）2026-10-24 提到 @/lib/market/backtest-day：
  // 这三个函数在 main() 里写了 10 天没人发现的聚合 bug（get 用 exitDate、set 用 date），
  // 内部函数没法写单测所以没人拦。口径和守门测试都在那个模块里，别在这里再抄一份。

  /**
   * 连亏几天的真实分布，直接从回测里数出来。
   *
   * 为什么要按天而不是按笔：同一天的十来个仓位是一起涨跌的，亏就一起亏。
   * 按笔算的话，一次回调就是「连亏十几笔」，看着像策略崩了，其实只是那天行情不好。
   */
  function streakStats(trades: Trade[]) {
    const days = byDay(trades);
    if (days.length === 0) return "";
    const streaks: number[] = [];
    let streak = 0;
    for (const value of days) {
      streak = value <= 0 ? streak + 1 : 0;
      streaks.push(streak);
    }
    const at = (n: number) => ((streaks.filter((s) => s >= n).length / streaks.length) * 100).toFixed(0);
    return (
      `连亏 ≥2 天 ${at(2)}% 的时间 · ≥3 天 ${at(3)}% · ≥5 天 ${at(5)}% · ≥8 天 ${at(8)}%` +
      `（最长 ${Math.max(...streaks)} 天，共 ${days.length} 个有成交的日子）`
    );
  }

  /**
   * 按天复利出来的净值回撤，起点算 1。
   * 每天的收益是那天仓位的平均值，所以这条曲线就是「等权组合」的净值，
   * 回撤可以和平时的百分比直接比，也才能和停手线比。
   */
  function drawdownByDay(trades: Trade[]): number {
    let equity = 1;
    let peak = 1;
    let worst = 0;
    for (const value of byDay(trades)) {
      equity *= 1 + value;
      if (equity > peak) peak = equity;
      if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
    }
    return worst;
  }

  /**
   * 「最近 N 笔平均收益」低于某个线的比例。
   *
   * 这是纸面账上唯一算得准的景气指标。回撤算不准：账本不记仓位大小，每笔都
   * 当满仓入账，十笔同日卖出的加起来等于十个满仓，净值和回撤都虚了好几倍
   * （中期反转一年能算出 80% 以上的回撤）。「最近这些笔平均是赚是亏」不受
   * 仓位假设影响，直接从每笔收益率就能看。
   */
  function recentMean(trades: Trade[], window = 20) {
    let hits2 = 0;
    let hits5 = 0;
    let hits8 = 0;
    let n = 0;
    let sum = 0;
    for (let i = 0; i < trades.length; i += 1) {
      sum += trades[i].ret;
      if (i >= window) sum -= trades[i - window].ret;
      if (i < window - 1) continue;
      const mean = sum / window;
      n += 1;
      if (mean < -0.02) hits2 += 1;
      if (mean < -0.05) hits5 += 1;
      if (mean < -0.08) hits8 += 1;
    }
    if (n === 0) return "";
    const pct = (v: number) => ((v / n) * 100).toFixed(0);
    return `最近 20 笔均值低于 -2% ${pct(hits2)}% 的时间 · -5% ${pct(hits5)}% · -8% ${pct(hits8)}%`;
  }

  /**
   * 按出场原因拆开看。光看平均收益看不出策略到底在赚什么钱：
   * 如果绝大多数是「到期按收盘价卖」，说明止盈止损基本没起过作用，
   * 那点收益就是持股期间的随机波动，跟选股没关系。
   */
  function breakdown(results: Record<string, Trade[]>, key: string) {
  const trades = results[key];
  if (trades.length === 0) return;
  const label: Record<string, string> = { stop: "止损", target: "到目标", time: "到期平仓" };
  const parts: string[] = [];
  for (const reason of ["target", "stop", "time"]) {
    const group = trades.filter((t) => t.reason === reason);
    if (group.length === 0) continue;
    const avg = group.reduce((s, t) => s + t.ret, 0) / group.length;
    const share = (group.length / trades.length) * 100;
    parts.push(`${label[reason]} ${share.toFixed(0)}%（均 ${(avg * 100).toFixed(2)}%）`);
  }
  console.log(`  ${STRATEGIES[key].label.padEnd(12)} ${parts.join("  ·  ")}`);
  const streak = streakStats(trades);
  if (streak) console.log(`  ${" ".repeat(12)} ${streak}`);
  const recent = recentMean(trades);
  if (recent) console.log(`  ${" ".repeat(12)} ${recent}`);
  }

  /**
   * 因子检验。调策略的参数是没用的，先把最原始的问题问清楚：
   * 某个量价指标高的票，未来几天是不是真的走得更好？
   * 每天收盘把全部股票按因子从低到高排成五档，次日开盘等权买入、持有 N 天按收盘卖，
   * 收益减掉同期全池，剩下的才是这个因子挑出来的东西。
   * 信噪比按「每天一个最高档减最低档」算，这样不会被某几天的暴涨暴跌带偏。
   */
  /**
   * 复合因子策略检验：把 N 个因子按当天横截面 z-score 合成一个分数，买分数最高的
   * topN 只，持 N 天。这是「因子 → 策略」的桥——单因子横截面 t>2 不等于组合成策略
   * 能赚钱（要过交易成本和执行结构），所以组合完必须用和策略同一把尺（逐日聚类 t）
   * 判，不能看因子 t。
   *
   * 方向：用因子预注册的 direction（不是用观测 t 的符号硬凑——那是过拟合）。
   * 只挑「观测 t 和预注册方向一致且显著」的因子进组合。
   */
  function analyzeComposite(
    daily: DailyRow[][],
    dates: string[],
    startIdx: number,
    hold: number,
    factorIndices: number[],
    directions: number[],
    topN: number,
  ): { clusterT: number | null; excess: number; n: number; days: number } | null {
    const trades: { ret: number; bench: number; exitDate: string }[] = [];
    for (let t = 0; t < daily.length; t += 1) {
      const exitDate = dates[startIdx + t + hold] ?? "";
      const rows: { ex: number; vals: number[] }[] = [];
      for (const r of daily[t]) {
        const vals = factorIndices.map((f) => r.vals[f]);
        if (vals.some((v) => v == null)) continue;
        rows.push({ ex: r.ex, vals: vals as number[] });
      }
      if (rows.length < topN * 3) continue;
      const zArr: number[][] = factorIndices.map(() => []);
      for (const r of rows) r.vals.forEach((v, i) => zArr[i].push(v));
      const zs = zArr.map((arr) => {
        const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
        const sd = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length) || 1;
        return arr.map((v) => (v - mean) / sd);
      });
      const scored = rows.map((r, i) => ({
        ex: r.ex,
        score: zs.reduce((s, z, k) => s + z[i] * directions[k], 0),
      }));
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored.slice(0, topN)) trades.push({ ret: s.ex, bench: 0, exitDate });
    }
    return clusterTOf(trades);
  }

  if (process.env.BT_FACTOR === "1") {
    const N = Number(process.env.BT_N ?? 3);
    const buckets = Number(process.env.BT_BUCKETS ?? 5);
    // 待验队列因子（AI/人工预登记、还没淘汰的）附加在**活跃**注册表后面一起跑。
    // 2026-11-05 起用 ACTIVE_FACTORS（全量 FACTORS 去掉已摘牌的 4 个）——
    // 摘牌的不再每轮占一个「未测」位。追加在尾部而不是插中间：后面 BT_DIAG
    // 分支用 findIndex 定位下标，追加能保持下标不变。tombstone 由 loadQueueFactors 跳过。
    const queueFactors = await loadQueueFactors();
    const factors = [...ACTIVE_FACTORS, ...queueFactors];
    const factorCount = factors.length;
    /** 队列因子在本轮的判决，跑完一起回写队列（failCount/淘汰）。 */
    const queueVerdicts: { id: string; passed: boolean; at: string }[] = [];
    const offsetVal = Number(process.env.BT_OFFSET ?? 0);
    // 财报基本面：t 日只用 ann_date <= t 的已披露记录（PIT，无前视）。
    // 文件没有（还没跑 fetch 脚本）就全是 null，基本面因子自动不参与分档。
    const fundFile = await loadFundamentals();
    if (fundFile) {
      const n = Object.keys(fundFile.byCode ?? {}).length;
      console.log(`财报基本面：data/backtest/fundamentals.json（${n} 只，按披露日 PIT 对齐）`);
    } else {
      console.log("财报基本面：fundamentals.json 不存在，f_roe/f_dtyoy/f_gm 本轮取 null 不参与分档");
    }

    // 生成某段区间的 daily 数据（每因子取值 + 未来 N 天超额 + 可交易近似）
    const buildDaily = (
      kl: Map<string, Row[]>,
      io: Map<string, Map<string, number>>,
      ds: string[],
      bo: (a: number, b: number) => number,
      from: number,
      to: number,
    ): DailyRow[][] => {
      const daily: DailyRow[][] = [];
      for (let t = from; t < to; t += 1) {
        const today: DailyRow[] = [];
        for (const [id, rows] of kl) {
          const idx = io.get(id)?.get(ds[t]);
          if (idx == null || idx < 61) continue;
          const nIdx = io.get(id)?.get(ds[t + 1]);
          const xIdx = io.get(id)?.get(ds[t + N]);
          if (nIdx == null || xIdx == null) continue;
          const inPrice = rows[nIdx].o;
          const outPrice = rows[xIdx].c;
          if (!(inPrice > 0) || !(outPrice > 0)) continue;
          const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate, id, ext);
          // 回测侧可交易近似：股价 >= 4、流通市值（快照）>= 40 亿。
          // ST 标记和真实涨跌停回测里拿不到，这里只做能确定的。
          const tradable = m.c >= 4 && (m.floatCap == null || m.floatCap >= 40);
          // 基本面三因子注值：t 日只用 ann_date <= t 的已披露记录（PIT，无前视），
          // 那天市面上没披露过财报就是 null，因子自动退出当天分档。
          const fund = fundFile ? pitValue(recordsOf(fundFile, id), ymd(ds[t])) : null;
          const mf = {
            ...m,
            fRoe: fund?.roe ?? null,
            fDtYoy: fund?.dtYoy ?? null,
            fGm: fund?.gm ?? null,
          };
          today.push({ vals: factors.map((f) => f.get(mf)), ex: outPrice / inPrice - 1 - bo(t + 1, t + N), tradable });
        }
        daily.push(today);
      }
      return daily;
    };

    /**
     * 因子检验的样本池：**独立于策略回测的样本**（BT_FACTOR_SAMPLE，默认 1200）。
     *
     * 为什么独立（2026-11-05）：以前因子检验直接用策略回测那份样本（跟着 BT_SAMPLE 走），
     * 于是同一天里「因子层的判决」和「策略层的判决」可能跑在不同样本上——每天的
     * auto-verdict 用 BT_SAMPLE=300（因子层），strategy-verdict 用 2400（策略层）。
     * 两层口径不一致，因子的信噪比还被小样本噪声压着：
     * **300 只样本下「25 个因子无一全过 6 关」是噪声造成的假象**（见 data/backtest/2026-11-05/ 基线说明）。
     *
     * 1200 这个数不是随便挑的：G4「换样本」要求换一批**不同的**票，
     * 所以样本池必须 ≤ 市场一半（step≥2）——否则主样本和换样本抽到同一批票，
     * G4 就是空转（2400 只时实测「原 0.13% / 换样本 0.13%」一模一样）。
     */
    const FACTOR_SAMPLE = Number(process.env.BT_FACTOR_SAMPLE ?? 1200);
    const fStep = Math.max(1, Math.floor(ids.length / FACTOR_SAMPLE));
    if (fStep < 2) {
      throw new Error(
        `因子检验样本池 ${FACTOR_SAMPLE} 只 ≥ 市场一半（${ids.length} 只）：` +
          `G4 换样本会抽到同一批票，这一关是空转（2026-11-05 实测过）。` +
          `把 BT_FACTOR_SAMPLE 调到 ≤ ${Math.floor(ids.length / 2)}。`,
      );
    }
    const factorIds = ids.filter((_, i) => (i + offsetVal) % fStep === 0).slice(0, FACTOR_SAMPLE);
    const fp = await factorPrep(factorIds, capFloor);
    const fStart = Math.max(0, fp.dates.length - WINDOW);
    console.log(`因子检验样本池：${factorIds.length} 只（BT_FACTOR_SAMPLE=${FACTOR_SAMPLE}，step=${fStep}）\n`);

    const mid = Math.floor((fStart + fp.dates.length - 2) / 2);
    const fullDaily = buildDaily(fp.klines, fp.idxOf, fp.dates, fp.benchOver, fStart, fp.dates.length - N);
    const full = analyzeFactors(fullDaily, factorCount, buckets);

    const first = analyzeFactors(buildDaily(fp.klines, fp.idxOf, fp.dates, fp.benchOver, fStart, Math.min(mid, fp.dates.length - N)), factorCount, buckets);
    const second = analyzeFactors(buildDaily(fp.klines, fp.idxOf, fp.dates, fp.benchOver, mid, fp.dates.length - N), factorCount, buckets);

    // ── 因子 → 策略：把过关因子组合成复合策略试一把 ──────────────────────
    // 这是「无数合适因子形成策略」的落地：z-score 合成、买 topN、持 N 天，
    // 用逐日聚类 t 判（和策略同一把尺）。BT_COMPOSITE_FACTORS 可指定因子，
    // 否则自动挑「观测 t 与预注册方向一致且 |t|≥2」的。
    {
      const autoPick = full
        .map((r, i) => ({ i, t: r.nDays > 0 ? r.t : 0 }))
        .filter((x) => x.t * factors[x.i].direction >= 2)
        .map((x) => x.i);
      const picked = process.env.BT_COMPOSITE_FACTORS
        ? process.env.BT_COMPOSITE_FACTORS.split(",")
            .map((id) => factors.findIndex((f) => f.id === id.trim()))
            .filter((i) => i >= 0)
        : autoPick;
      if (picked.length > 0) {
        const topN = Number(process.env.BT_COMPOSITE_TOPN ?? 5);
        const dirs = picked.map((i) => factors[i].direction);
        const comp = analyzeComposite(fullDaily, fp.dates, fStart, N, picked, dirs, topN);
        if (comp) {
          console.log(`\n── 复合因子策略（${picked.length} 个因子 → top${topN}，持 ${N} 天，逐日聚类）──`);
          console.log(`  因子：${picked.map((i) => factors[i].name).join(" + ")}`);
          console.log(
            `  全样本(样本内) clusterT=${comp.clusterT == null ? "算不出" : (comp.clusterT >= 0 ? "+" : "") + comp.clusterT.toFixed(2)}` +
              `  excess=${(comp.excess * 100).toFixed(2)}pp  n=${comp.n} days=${comp.days}`,
          );
        }
        // 样本外：因子只用前半段挑（first 的 t），组合策略在后半段验。
        // 全样本那个 +2.25 是「同一份数据挑因子、又在这份数据上测」，必须拿这条对照。
        const oosPicked = first
          .map((r, i) => ({ i, t: r.nDays > 0 ? r.t : 0 }))
          .filter((x) => x.t * factors[x.i].direction >= 2)
          .map((x) => x.i);
        if (oosPicked.length > 0) {
          const oosDirs = oosPicked.map((i) => factors[i].direction);
          const secondDaily = buildDaily(fp.klines, fp.idxOf, fp.dates, fp.benchOver, mid, fp.dates.length - N);
          const oos = analyzeComposite(secondDaily, fp.dates, mid, N, oosPicked, oosDirs, topN);
          if (oos) {
            console.log(`  ── 样本外（前段挑 ${oosPicked.length} 个因子 → 后段验）──`);
            console.log(`  因子：${oosPicked.map((i) => factors[i].name).join(" + ")}`);
            console.log(
              `  样本外 clusterT=${oos.clusterT == null ? "算不出" : (oos.clusterT >= 0 ? "+" : "") + oos.clusterT.toFixed(2)}` +
                `  excess=${(oos.excess * 100).toFixed(2)}pp  n=${oos.n} days=${oos.days}`,
            );
          }
        }
      }
    }

    // G4 换样本：错开一位的**另一批**票（step≥2 保证与主样本不重叠），跑同一套检验
    const resampleIds = ids.filter((_, i) => (i + offsetVal + 1) % fStep === 0).slice(0, FACTOR_SAMPLE);
    const rp = await factorPrep(resampleIds, capFloor);
    const rStart = Math.max(0, rp.dates.length - WINDOW);
    const resample = analyzeFactors(buildDaily(rp.klines, rp.idxOf, rp.dates, rp.benchOver, rStart, rp.dates.length - N), factorCount, buckets);

    const measuredFlags = full.map((r) => r.nDays > 0);
    /**
     * 检验族大小 = **真正测过的**因子数。
     *
     * 为什么不是 factorCount：有的因子虽然注册了，但这一轮的有效样本日数为 0
     * （数据没接上 / 横截面凑不齐分档），`nDays === 0`——**从来没测过**，
     * 不是「测了没效果」。把它算进检验族，多重检验的运气线（BH-FDR / DSR）
     * 就按「多试了一个」来罚，真实因子的及格线被没做过的检验白白抬高。
     *
     * 「拿不到 ≠ 没有」在因子层的落地：没做的检验不算检验，也没资格占一个判决位。
     * 2026-11-05：当初那 8 个里已接上 4 个（融券/主力/板块/公告），
     * 剩下 4 个**已摘牌**（见 retired-factors.ts），不再每轮占一个「未测」位。
     */
    const nTested = measuredFlags.filter(Boolean).length;
    /**
     * G5（BH-FDR）要的是**这一轮所有实测因子的 t**：名次和 step-up 的 k 都要靠它算。
     * 只放实测的（没测的 nDays=0、t=0，不该占名次——没做的检验不算检验）。
     */
    const allMeasuredTs = full.filter((r) => r.nDays > 0).map((r) => r.t);
    const totalDays = full.reduce((s, r) => Math.max(s, r.nDays), 0);
    /**
     * DSR（学 Vibe-Trading 的 deflated sharpe）：把「试了 nTested 个因子、运气最好
     * 的那个该有多显著」当基准线，回答「这个信噪比是不是搜出来的」。
     * 每个因子的 per-period 夏普由 t/√nDays 还原（robustness.perPeriodSharpe），
     * 全体因子的夏普散布 = trial_sharpe_std。只记进账本展示，不改 6 关判决。
     */
    const perPeriodAll = full.map((r) => perPeriodSharpe(r.t, r.nDays));
    const trialSharpeStd = trialStd(perPeriodAll);
    const dsrOfFactor = (r: (typeof full)[number]): { value: number; expectedMax: number; survives: boolean; nTrials: number } | null => {
      if (r.nDays < 20 || trialSharpeStd <= 0) return null;
      try {
        const out = dsrOf(perPeriodSharpe(r.t, r.nDays), nTested, r.nDays, trialSharpeStd, r.spreadSkew ?? 0, r.spreadKurt ?? 3);
        return { value: out.dsr, expectedMax: out.expectedMaxSharpe, survives: out.survives, nTrials };
      } catch {
        return null;
      }
    };
    console.log(
      `因子检验：${totalDays} 个交易日 · ${factorCount} 个因子 · 持有 ${N} 天 · ${buckets} 档` +
        `${offsetVal ? ` · 换样本 offset=${offsetVal}` : ""}\n` +
        `  t 日收盘排序，次日开盘买入、持有 ${N} 天后按收盘卖出，减同期全池\n`,
    );

    const mark = (g: { pass: boolean }) => (g.pass ? "✓" : "✗");
    console.log("因子          方向   G1    G2    G3    G4    G5    G6      顶-底      t");
    console.log("-".repeat(92));

    const logLines: string[] = [];
    for (let f = 0; f < factorCount; f += 1) {
      const factor = factors[f];
      const run = full[f];
      const dsrInfo = dsrOfFactor(run);
      // 从没测到的因子（nDays=0）：数据整个没有，不是「测了没效果」。
      // 不判 6 关（判了就是拿「没测」冒充「没效果」），不进检验族，页面上显示「未测」。
      const measured = measuredFlags[f];
      if (!measured) {
        console.log(
          factor.name.padEnd(10) +
            "数据缺失·未测".padEnd(22) +
            "（不判 6 关、不计入检验族——没做的检验不算检验）",
        );
      }
      const g1 = gateMonotonic(run.bucketMeans, factor.direction);
      const g2 = gateT(run.t);
      const g3 = gateHalves(first[f], second[f]);
      const g4 = gateResample(run, resample[f]);
      const g5 = gateFdr(run.t, allMeasuredTs);
      const g6 = gateTradable(run.topBlockedRatio);
      console.log(
        factor.name.padEnd(10) +
          (factor.direction > 0 ? "正向" : "反向").padEnd(5) +
          [g1, g2, g3, g4, g5, g6].map((g) => mark(g).padEnd(5)).join("") +
          `${(run.meanSpread >= 0 ? "+" : "") + (run.meanSpread * 100).toFixed(2)}%`.padStart(9) +
          run.t.toFixed(2).padStart(7),
      );
      const at = new Date().toISOString();
      logLines.push(
        JSON.stringify({
          at,
          factor: factor.id,
          name: factor.name,
          direction: factor.direction,
          n: N,
          buckets,
          offset: offsetVal,
          /**
           * 样本量：**因子检验的样本池**（factorIds.length），不是策略回测那份。
           * 2026-11-05 之前这里写的是 sample.length（策略样本），而因子检验早已独立
           * 出去用 BT_FACTOR_SAMPLE 了 —— 记的数和实际判的数对不上，AI 读账会被误导。
           */
          universe: factorIds.length,
          nDays: run.nDays,
          meanSpread: run.meanSpread,
          t: run.t,
          topBlockedRatio: run.topBlockedRatio,
          bucketMeans: run.bucketMeans,
          resampleSpread: resample[f].meanSpread,
          resampleT: resample[f].t,
          /**
           * 前后两段各自的 spread / t。以前算完就丢了，导致 G3（两段同向）在页面
           * 上只能显示 ✓/✗，说不出「前 +0.13% / 后 -0.72%」这种原话。
           * 旧批次没有这两个字段——页面遇到就显示「这关没记」，不能编。
           */
          halfSpread: [first[f].meanSpread, second[f].meanSpread],
          halfT: [first[f].t, second[f].t],
          /** 每关的判据原话（如「|t|= 4.35 vs 临界 3.15（N=25）」），页面直接显示。 */
          gateDetails: {
            g1: g1.detail,
            g2: g2.detail,
            g3: g3.detail,
            g4: g4.detail,
            g5: g5.detail,
            g6: g6.detail,
          },
          gates: measured
            ? { g1: g1.pass, g2: g2.pass, g3: g3.pass, g4: g4.pass, g5: g5.pass, g6: g6.pass }
            : // 没测到的因子不判 6 关：gates 留空（不是全 ✗），页面显示「未测」。
              // 「没测」和「测了没过」在数据上必须能分开。
              {},
          /** 这一轮到底测了没有（false = 数据整个没有，不是「测了没效果」）。 */
          measured,
          nTested,
          /** spread 分布形状 + 运气线校正（Vibe-Trading DSR）。旧批次没有。 */
          spreadSkew: run.spreadSkew,
          spreadKurt: run.spreadKurt,
          dsr: dsrInfo,
          /** IC/ICIR（Vibe Alpha Zoo）：逐日横截面秩相关序列的均值与稳定性。旧批次没有。 */
          ic: run.icDays > 0 ? { mean: run.icMean, icir: run.icir, days: run.icDays, positiveRatio: run.icPositiveRatio } : null,
        }),
      );
      // 队列因子（f 排在注册表后面）记下判决，整轮跑完一起回写队列状态。
      // 2026-10-27 从 6 关改 4 关：g1~g4 过即算 passed。
      // g5（Bonferroni）和 g6（可交易）变展示层证据——不过不挡路，但双不过的因子
      // 在 verdict 里依然会标出来，方便审计。
      if (f >= ACTIVE_FACTORS.length) {
        const corePassed = [g1, g2, g3, g4].every((g) => g.pass);
        const allPassed = corePassed && g5.pass && g6.pass;
        queueVerdicts.push({
          id: factor.id,
          passed: corePassed,
          at,
          /** 这一轮到底测了没有——队列里「没测」的因子不算失败（见 factor-queue.ts）。 */
          measured,
          failedGates: [g1, g2, g3, g4, g5, g6].flatMap((g, i) => (g.pass ? [] : [`g${i + 1}`])),
          // DSR 是展示层证据，过关失败都存档——回答「这个因子是不是搜出来的」。
          dsr: dsrInfo ?? undefined,
          // IC/ICIR 同 DSR：展示层证据，过关失败都存档——回答「信号稳不稳」。
          ic: run.icDays > 0 ? { mean: run.icMean, icir: run.icir, days: run.icDays } : undefined,
        });
      }
    }
    console.log("-".repeat(92));
    {
      const judged = full.map((r, i) => ({ i, d: dsrOfFactor(r) })).filter((x) => x.d);
      if (judged.length > 0) {
        const surviveN = judged.filter((x) => x.d!.survives).length;
        console.log(
          `DSR（运气线校正，试 ${nTested} 个）：${surviveN}/${judged.length} 个因子的显著性过了「运气最好」这道线` +
            `——没过的不是没用，是这点样本分不清它和搜出来的运气。`,
        );
      }
    }

    // 分档均值明细（全区间），看单调形状
    console.log("\n分档均值（全区间，从最低档到最高档）：");
    for (let f = 0; f < factorCount; f += 1) {
      const cells = full[f].bucketMeans.map((v) => `${(v >= 0 ? "+" : "") + (v * 100).toFixed(2)}%`.padStart(8)).join(" ");
      console.log(`  ${factors[f].name.padEnd(10)} ${cells}`);
    }

    // —— 缩量天数归因（BT_DIAG=shrinkDays，研究性，不进 6 关）——
    if (process.env.BT_DIAG === "shrinkDays") {
      const fShrink = ACTIVE_FACTORS.findIndex((f) => f.id === "shrinkDays");
      const fD60 = ACTIVE_FACTORS.findIndex((f) => f.id === "d60");
      if (fShrink >= 0 && fD60 >= 0) {
        const diag = diagnoseShrinkDays(fullDaily, fShrink, fD60, buckets);
        console.log("\n缩量天数归因（BT_DIAG=shrinkDays）：");
        console.log(`  shrinkDays 与 d60 横截面 Spearman 均值 = ${diag.corrAll.toFixed(3)}（|ρ| 越低越不像同一个信号）`);
        console.log(`  分段相关性：${diag.corrSeg.map((v) => v.toFixed(2)).join(" / ")}`);
        console.log(
          `  分段 shrinkDays 顶-底 spread：${diag.spreadSeg
            .map((v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%")
            .join(" / ")}`,
        );
        console.log(
          `  d60 中性化后 shrinkDays 独立 spread = ${(diag.neutSpread >= 0 ? "+" : "") + (diag.neutSpread * 100).toFixed(2)}%` +
            `（t=${diag.neutT.toFixed(2)}，${diag.neutDays} 天）`,
        );
        console.log("  判读：中性化后 |t| 仍在 2 以上 → shrinkDays 有独立于 d60 的信息，不是马甲。");

        // 精确到交易日：5 日滚动平均滤掉单日噪声，定位翻脸（spread>0）的日期段
        const series = diag.spreadSeries;
        const win = 5;
        const smooth = series.map((x, k) => {
          const slice = series.slice(Math.max(0, k - win + 1), k + 1);
          return { date: dates[startIdx + x.idx], spread: slice.reduce((s, y) => s + y.spread, 0) / slice.length };
        });
        console.log("\n精确到交易日（5 日滚动平均后的顶-底 spread，只列正的=翻脸段；同期全池=这段全市场等权涨跌）：");
        // 翻脸段也要落盘——它们在终端闪一下就没了，而「13 段零散、不是一整段」
        // 正是这次归因最要紧的证据，必须留在页面上。
        const segs: { from: string; to: string; days: number; rollingSpread: number; poolRet: number }[] = [];
        let runStart: number | null = null;
        let found = 0;
        for (let k = 0; k <= smooth.length; k += 1) {
          const pos = k < smooth.length && smooth[k].spread > 0;
          if (pos && runStart == null) runStart = k;
          if ((!pos || k === smooth.length) && runStart != null) {
            const seg = smooth.slice(runStart, k);
            const segSpread = seg.reduce((s, x) => s + x.spread, 0) / seg.length;
            const a = datePos.get(seg[0].date) ?? -1;
            const b = datePos.get(seg[seg.length - 1].date) ?? -1;
            const pool = a >= 0 && b >= 0 ? benchOver(a, b) : 0;
            console.log(
              `  ${seg[0].date} ~ ${seg[seg.length - 1].date}：滚动 spread ${(segSpread >= 0 ? "+" : "") + (segSpread * 100).toFixed(2)}%` +
                `（${seg.length} 天）· 同期全池 ${(pool >= 0 ? "+" : "") + (pool * 100).toFixed(1)}%`,
            );
            segs.push({
              from: seg[0].date,
              to: seg[seg.length - 1].date,
              days: seg.length,
              rollingSpread: segSpread,
              poolRet: pool,
            });
            runStart = null;
            found += 1;
          }
        }
        if (found === 0) console.log("  （没有连续为正的交易日段）");

        await appendDiag({
          kind: "shrinkFlip",
          n: N,
          buckets,
          nTested: factorCount,
          nDays: diag.neutDays,
          rollingWindow: win,
          corrAll: diag.corrAll,
          corrSeg: diag.corrSeg,
          spreadSeg: diag.spreadSeg,
          neutSpread: diag.neutSpread,
          neutT: diag.neutT,
          neutDays: diag.neutDays,
          segments: segs,
        });
      }
    }

    // —— 缩量+止跌复合诊断（BT_DIAG=shrinkBull，研究性）——
    if (process.env.BT_DIAG === "shrinkBull") {
      const fShrink = ACTIVE_FACTORS.findIndex((f) => f.id === "shrinkDays");
      const fChg = ACTIVE_FACTORS.findIndex((f) => f.id === "chg");
      const fD60 = ACTIVE_FACTORS.findIndex((f) => f.id === "d60");
      if (fShrink >= 0 && fChg >= 0 && fD60 >= 0) {
        const byDay = diagnoseShrinkBull(fullDaily, fShrink, fChg, buckets);
        const mean = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
        const tOf = (l: number[]) => {
          if (l.length < 2) return 0;
          const m = mean(l);
          const sd = Math.sqrt(l.reduce((s, v) => s + (v - m) ** 2, 0) / (l.length - 1));
          return sd > 0 ? m / (sd / Math.sqrt(l.length)) : 0;
        };
        const bull = byDay.map((d) => d.topBull).filter((v): v is number => v != null);
        const bear = byDay.map((d) => d.topBear).filter((v): v is number => v != null);
        const premium = byDay
          .map((d) => (d.topBull != null && d.topBear != null ? d.topBull - d.topBear : null))
          .filter((v): v is number => v != null);

        console.log("\n缩量+止跌复合诊断（BT_DIAG=shrinkBull，顶档=缩量最多那一档）：");
        console.log(`  止跌组（当日收涨）平均超额 ${(mean(bull) >= 0 ? "+" : "") + (mean(bull) * 100).toFixed(2)}%（${bull.length} 天）`);
        console.log(`  不止跌组平均超额       ${(mean(bear) >= 0 ? "+" : "") + (mean(bear) * 100).toFixed(2)}%（${bear.length} 天）`);
        console.log(`  止跌溢价（止跌−不止跌）${(mean(premium) >= 0 ? "+" : "") + (mean(premium) * 100).toFixed(2)}%，t=${tOf(premium).toFixed(2)}`);

        // 翻脸段（缩量整体失效的时段）里，止跌组是否还扛得住
        const diagDays = diagnoseShrinkDays(fullDaily, fShrink, fD60, buckets);
        const win = 5;
        const smooth = diagDays.spreadSeries.map((x, k) => {
          const s = diagDays.spreadSeries.slice(Math.max(0, k - win + 1), k + 1);
          return { date: dates[startIdx + x.idx], spread: s.reduce((a, y) => a + y.spread, 0) / s.length };
        });
        console.log("\n翻脸段（5 日滚动 spread>0）里，止跌 vs 不止跌：");
        const flipSegments: { from: string; to: string; days: number; bull: number | null; bear: number | null }[] = [];
        let rs: number | null = null;
        let rows = 0;
        for (let k = 0; k <= smooth.length; k += 1) {
          const pos = k < smooth.length && smooth[k].spread > 0;
          if (pos && rs == null) rs = k;
          if ((!pos || k === smooth.length) && rs != null) {
            const seg = smooth.slice(rs, k);
            const d0 = seg[0].date;
            const d1 = seg[seg.length - 1].date;
            const inSeg = byDay.filter((d) => {
              const dd = dates[startIdx + d.idx];
              return dd >= d0 && dd <= d1;
            });
            const b = inSeg.map((d) => d.topBull).filter((v): v is number => v != null);
            const e = inSeg.map((d) => d.topBear).filter((v): v is number => v != null);
            if (b.length || e.length) {
              console.log(
                `  ${d0} ~ ${d1}：止跌 ${(mean(b) >= 0 ? "+" : "") + (mean(b) * 100).toFixed(2)}% / 不止跌 ${(mean(e) >= 0 ? "+" : "") + (mean(e) * 100).toFixed(2)}%（${seg.length} 天）`,
              );
              rows += 1;
            }
            // 一组都算不出来时存 null，不存 0——0 会被读成「不赚不亏」，其实是没答案。
            flipSegments.push({
              from: d0,
              to: d1,
              days: seg.length,
              bull: b.length ? mean(b) : null,
              bear: e.length ? mean(e) : null,
            });
            rs = null;
          }
        }
        if (rows === 0) console.log("  （没有翻脸段）");
        console.log("  判读：止跌溢价 t≥2 且翻脸段里止跌组仍显著为正 → 止跌条件能把失效滤掉。");

        await appendDiag({
          kind: "shrinkBull",
          n: N,
          buckets,
          bullMean: mean(bull),
          bullDays: bull.length,
          bearMean: mean(bear),
          bearDays: bear.length,
          premiumMean: mean(premium),
          premiumT: tOf(premium),
          premiumDays: premium.length,
          flipSegments,
        });
      }
    }

    const logPath = `${DATA_DIR}/backtest/factor-runs.jsonl`;
    // 诊断/复跑时用 BT_NO_LOG=1 跳过追加，避免同一批因子反复污染日志。
    if (process.env.BT_NO_LOG !== "1") {
      await appendFile(logPath, logLines.join("\n") + "\n");
      console.log(`\n因子日志已追加 → ${logPath}（${logLines.length} 条）`);
    }
    // 队列状态回写：跑了就算数（BT_NO_LOG 只是不记日志，检验本身发生了）。
    if (queueVerdicts.length > 0) {
      await applyVerdictsToQueue(queueVerdicts);
      const passed = queueVerdicts.filter((v) => v.passed).length;
      console.log(`待验队列已更新：${queueVerdicts.length} 个跑了，${passed} 个过 6 关（连续 2 次不过自动淘汰）`);
    }
    console.log("判据：|t|<2=没测出；两段翻脸=不能用；Bonferroni 后不显著=降级；顶档被挡过半=不可交易。");
    return;
  }

  // —— 资金流因子探路（BT_FLOW=1，东财 120 日主力净流入）——
  // 这是「最小验证」：先花小代价看资金流维度有没有独立于 OHLCV 的信息，再决定
  // 要不要建长历史缓存。所以：
  //   - G4 换样本没做（只有主样本的资金流缓存）
  //   - G3 两段在 120 天窗口里各 60 天，偏短，结论只当「方向」，不当「过关」
  if (process.env.BT_FLOW === "1") {
    const N = Number(process.env.BT_N ?? 10);
    const buckets = Number(process.env.BT_BUCKETS ?? 5);

    // 1. 加载资金流缓存
    const flowOf = new Map<string, Map<string, { main: number; ratio: number }>>();
    let flowLoaded = 0;
    for (const id of klines.keys()) {
      try {
        const rows = JSON.parse(await readFile(`${CACHE}/../flow/${id}.json`, "utf8")) as { date: string; main: number; ratio: number }[];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const m = new Map<string, { main: number; ratio: number }>();
        for (const r of rows) m.set(r.date, { main: r.main, ratio: r.ratio });
        flowOf.set(id, m);
        flowLoaded += 1;
      } catch {
        // 没拉到缓存，跳过
      }
    }
    console.log(`资金流探路：缓存命中 ${flowLoaded}/${klines.size} 只\n`);

    // 2. 资金流因子（预注册，方向 +1 = 主力净流入越多未来超额越高）
    //    mainRatio  = 当日主力净流入 / 当日成交额
    //    mainRatio5 = 近 5 日主力净流入累计 / 近 5 日成交额累计
    // 陷阱：这俩和当日涨跌幅强相关，下面用 chg 中性化看独立信息。
    const flowFactors = [
      { id: "mainRatio", name: "主力净流入占比", direction: 1 },
      { id: "mainRatio5", name: "主力5日累计占比", direction: 1 },
    ];

    // 3. 构建 daily（vals = [mainRatio, mainRatio5, chg]，chg 只用于正交化）
    const flowDaily: DailyRow[][] = [];
    for (let t = startIdx; t < dates.length - N; t += 1) {
      const today: DailyRow[] = [];
      for (const [id, rows] of klines) {
        const idx = idxOf.get(id)?.get(dates[t]);
        if (idx == null || idx < 61) continue;
        const flow = flowOf.get(id);
        if (!flow) continue;
        const nIdx = idxOf.get(id)?.get(dates[t + 1]);
        const xIdx = idxOf.get(id)?.get(dates[t + N]);
        if (nIdx == null || xIdx == null) continue;
        const inPrice = rows[nIdx].o;
        const outPrice = rows[xIdx].c;
        if (!(inPrice > 0) || !(outPrice > 0)) continue;

        const f = flow.get(dates[t]);
        if (!f) continue;
        const amount = rows[idx].v * 100 * rows[idx].c;
        if (amount <= 0) continue;
        const mainRatio = f.main / amount;

        let main5 = 0;
        let amount5 = 0;
        for (let k = idx - 4; k <= idx; k += 1) {
          if (k < 0) continue;
          const fk = flow.get(rows[k].date);
          const ak = rows[k].v * 100 * rows[k].c;
          if (fk) {
            main5 += fk.main;
            amount5 += ak;
          }
        }
        const mainRatio5 = amount5 > 0 ? main5 / amount5 : null;

        const prev = idx - 1 >= 0 ? rows[idx - 1].c : rows[idx].c;
        const chg = prev > 0 ? ((rows[idx].c - prev) / prev) * 100 : 0;

        today.push({ vals: [mainRatio, mainRatio5, chg], ex: outPrice / inPrice - 1 - benchOver(t + 1, t + N) });
      }
      flowDaily.push(today);
    }

    const effectiveDays = flowDaily.filter((d) => d.length > 0).length;
    const halfLen = Math.floor(flowDaily.length / 2);
    const runs = analyzeFactors(flowDaily, 2, buckets);
    const first = analyzeFactors(flowDaily.slice(0, halfLen), 2, buckets);
    const second = analyzeFactors(flowDaily.slice(halfLen), 2, buckets);

    console.log(`资金流因子探路：${effectiveDays} 个有效交易日 · 持有 ${N} 天 · ${buckets} 档`);
    console.log("因子          方向   G1    G2    G3         G5    G6      顶-底      t");
    console.log("-".repeat(90));
    const mark = (g: { pass: boolean }) => (g.pass ? "✓" : "✗");
    for (let f = 0; f < 2; f += 1) {
      const run = runs[f];
      const g1 = gateMonotonic(run.bucketMeans, 1);
      const g2 = gateT(run.t);
      const g3 = gateHalves(first[f], second[f]);
      const g5 = gateBonferroni(run.t, 2);
      const g6 = gateTradable(run.topBlockedRatio);
      console.log(
        flowFactors[f].name.padEnd(10) +
          "正向".padEnd(5) +
          [g1, g2, g3, g5, g6].map((g) => mark(g).padEnd(5)).join("") +
          `${(run.meanSpread >= 0 ? "+" : "") + (run.meanSpread * 100).toFixed(2)}%`.padStart(9) +
          run.t.toFixed(2).padStart(7),
      );
    }
    console.log("-".repeat(90));
    for (let f = 0; f < 2; f += 1) {
      const cells = runs[f].bucketMeans.map((v) => `${(v >= 0 ? "+" : "") + (v * 100).toFixed(2)}%`.padStart(8)).join(" ");
      console.log(`  ${flowFactors[f].name.padEnd(10)} ${cells}`);
    }

    console.log("\nchg 正交化（控制当日涨幅后，资金流因子的独立 spread）：");
    // 探路结果落盘：持有期压测（N=5/10/20）要三条凑成一张表才看得出「只在 N=10 过 2」，
    // 终端里一条一条看是看不出来的。
    const probeFactors = [];
    for (let f = 0; f < 2; f += 1) {
      const run = runs[f];
      const g1 = gateMonotonic(run.bucketMeans, 1);
      const g2 = gateT(run.t);
      const g3 = gateHalves(first[f], second[f]);
      const g5 = gateBonferroni(run.t, 2);
      const g6 = gateTradable(run.topBlockedRatio);
      const diag = diagnoseShrinkDays(flowDaily, f, 2, buckets);
      console.log(
        `  ${flowFactors[f].name.padEnd(10)} 独立 spread ${(diag.neutSpread >= 0 ? "+" : "") + (diag.neutSpread * 100).toFixed(2)}%` +
          `（t=${diag.neutT.toFixed(2)}）`,
      );
      probeFactors.push({
        id: flowFactors[f].id,
        name: flowFactors[f].name,
        direction: flowFactors[f].direction,
        spread: run.meanSpread,
        t: run.t,
        nDays: run.nDays,
        topBlockedRatio: run.topBlockedRatio,
        bucketMeans: run.bucketMeans,
        // 只有 5 关——这次探路确实没做 G4 换样本。缺的样子就是缺，别补 false。
        gates: { g1: g1.pass, g2: g2.pass, g3: g3.pass, g5: g5.pass, g6: g6.pass },
        gateDetails: { g1: g1.detail, g2: g2.detail, g3: g3.detail, g5: g5.detail, g6: g6.detail },
        neutSpread: diag.neutSpread,
        neutT: diag.neutT,
        neutDays: diag.neutDays,
      });
    }
    await appendDiag({
      kind: "flowProbe",
      n: N,
      buckets,
      effectiveDays,
      cacheHit: flowLoaded,
      cacheTotal: klines.size,
      factors: probeFactors,
    });
    console.log("判读：独立 t 仍在 2 以上 → 资金流有 OHLCV 之外的信息，值得建长历史缓存。");
    return;
  }

  if (process.env.BT_SWEEP === "1") {
    console.log("止损幅度扫描（同一套选股条件，只改止损百分比）\n");
    for (const stopPct of [2, 3, 4, 5, 6]) {
      report(runPass(stopPct), `止损 -${stopPct}%:`);
      console.log("");
    }
    console.log(`同期沪深 300 买入持有：${(benchRet * 100).toFixed(1)}%（作为参照）`);
  } else {
    const stopOverride = process.env.BT_STOP ? Number(process.env.BT_STOP) : undefined;
    const results = runPass(stopOverride);
    // 主结果这次要落 JSONL（页面读它）；止损扫描那次不落——中间数字不是「一次运行的结果」
    report(results, process.env.BT_HALF ? `区间：${process.env.BT_HALF} 段` : "", true);
    // 实验用逐笔落盘（BT_DUMP=<路径>）：bootstrap / 事后复核要逐笔序列，
    // 汇总指标不够。带 BT_NO_LOG=1 时也不会污染 runs.jsonl。
    if (process.env.BT_DUMP) {
      const { dirname } = await import("node:path");
      await mkdir(dirname(process.env.BT_DUMP), { recursive: true });
      await writeFile(
        process.env.BT_DUMP,
        JSON.stringify({
          ranAt: new Date().toISOString(),
          env: {
            half: process.env.BT_HALF ?? null,
            offset: Number(process.env.BT_OFFSET ?? 0),
            buyMode: process.env.BT_BUYMODE ?? "limit",
            hold: process.env.BT_HOLD ?? null,
            stop: process.env.BT_RSTOP ?? null,
            target: process.env.BT_RTARGET ?? null,
            experiment: process.env.BT_REBOUND_EXP === "1",
          },
          trades: results,
        }),
      );
      console.log(`\n逐笔明细已落盘 ${process.env.BT_DUMP}（bootstrap/复核用）`);
    }
    console.log("出场原因拆解：");
    for (const key of Object.keys(STRATEGIES)) breakdown(results, key);
    console.log("");
    console.log(
      `入场撮合（口径 ${fillMode}）：跳空成交 ${fillStats.gap} 笔，开在止损下方不算 ${fillStats.belowStop} 笔，挂价没碰到 ${fillStats.missed} 笔`,
      ...Object.entries(fillStats.missByStyle ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  未成交：${STRATEGIES[k]?.label ?? k} ${v} 笔`),
    );
    // 费用 drag 对照（学 Vibe-Research 的 cost_compare）：同一套交易费用清零再跑一遍。
    // drag = 有费均值 − 免费均值；只看有费收益会把策略的实际盈利能力高估 drag 那么多。
    // BT_COSTCOMPARE=0 关掉（扫参等大批量跑时省一半时间）。
    if (process.env.BT_COSTCOMPARE !== "0") {
      const freeResults = runPass(stopOverride, 0);
      const labels = Object.fromEntries(Object.entries(STRATEGIES).map(([k, d]) => [k, d.label]));
      console.log("\n费用 drag 对照（同一套交易，费用清零重跑）：");
      console.log("策略            笔数   有费平均   免费平均      drag");
      console.log("-".repeat(56));
      for (const row of costDragRows(labels, results, freeResults)) {
        console.log(formatDragRow(row));
      }
      console.log("-".repeat(56));
      console.log("drag 应约等于一来一回费率；差得多说明两笔账不是同一套交易，对照无效。");
    }
    console.log(`同期沪深 300 买入持有：${(benchRet * 100).toFixed(1)}%（作为参照）`);

    // 顺手落一份结构化记录（页面 /backtest 读它）。**只追加不改**：跑一次加一行。
    // 环境参数和数字一起存——成本口径改过一次（0.102% → 0.302%），不带 env 的历史
    // 数字没法和新的比。
    if (process.env.BT_NO_LOG !== "1" && runStats.length > 0) {
      const record: BacktestRun = {
        ranAt: new Date().toISOString(),
        ranDate: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
        env: {
          start: startDate,
          end: endDate,
          days: dates.length - startIdx,
          sample: SAMPLE,
          covered: klines.size,
          fillMode,
          fee: FEE + SLIPPAGE * 2,
          turnoverGate: useTurnoverGate,
          stopPct: stopOverride ?? null,
          bench300: benchRet,
        },
        styles: runStats,
        note: process.env.BT_HALF ? `区间 ${process.env.BT_HALF} 段` : null,
      };
      await appendFile(RUNS_PATH, `${JSON.stringify(record)}\n`, "utf-8");
      console.log(`\n已记录本次运行到 ${RUNS_PATH}（页面 /backtest 能看到了）`);
    }
  }
  console.log("\n注：单笔收益率等权累加，不是复利；样本含幸存者偏差，实际会差一些。");
}

await main();
