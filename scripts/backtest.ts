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
 * 2. 历史换手率、市值、市盈率拿不到，只能用量价替代 —— 所以 value 那套回测不了
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
 * 流通市值反推补上了（成交额 ÷ 流通市值，和腾讯的 hsl 同口径，吻合率 99.8%）。
 * 跑 `node scripts/build-floatcap.mjs` 生成缓存；没有缓存时会在开头大声提示
 * 这道闸没生效，不会静默地退回宽松口径。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { exitFill } from "@/lib/market/journal-book";
import { boardLimit } from "@/lib/market/model";
import { holdOf } from "@/lib/market/strategies";
import type { BacktestRun, BacktestStyleStat } from "@/lib/market/backtest-runs";
import { RUNS_PATH } from "@/lib/market/backtest-runs";
import type { StyleId } from "@/lib/market/strategies";
import type { Bar } from "@/lib/market/types";
import {
  FACTORS,
  analyzeFactors,
  gateMonotonic,
  gateT,
  gateHalves,
  gateResample,
  gateBonferroni,
  gateTradable,
  diagnoseShrinkDays,
  diagnoseShrinkBull,
} from "@/lib/market/factors";
import type { DailyRow } from "@/lib/market/factors";
import { detectWyckoffSpring } from "@/lib/market/wyckoff-spring";
import { decideGate, costDragRows, formatDragRow, klineRef } from "@/lib/market/backtest-gate";
import { loadQueueFactors, applyVerdictsToQueue } from "@/lib/market/factor-queue";
import { dsr as dsrOf, perPeriodSharpe, std as trialStd } from "@/lib/market/robustness";
import { pitValue, recordsOf } from "@/lib/market/fundamentals";
import type { FundamentalFile } from "@/lib/market/fundamentals";

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
/** 抽多少只股票。全市场五千多只全拉太慢，抽样已经能看出方向。 */
const SAMPLE = Number(process.env.BT_SAMPLE ?? 300);
/** 每套策略每天最多买几只，和线上一致。 */
const MAX_POSITIONS = 10;
/** 一来一回的手续费，和线上一致（0.102%）。拆开写是为了让每一项都能被核对：
 *  佣金 万2.5 双边 + 过户费 万0.1 双边 + 印花税 万5 卖出单边 = 0.00102。
 *  以前这里只有一个数字，所以披露段敢写「未计印花税」——其实早就算进去了（2026-10-12 发现）。 */
export const COMMISSION_RATE = 0.00025;
export const COMMISSION_MIN = 5;
export const TRANSFER_FEE = 0.00001;
export const STAMP_TAX = 0.0005;
const FEE = COMMISSION_RATE * 2 + TRANSFER_FEE * 2 + STAMP_TAX;

/**
 * 滑点（单边）。默认万 10，买卖各一次 = 一来一回 0.2%——比上面全部手续费还多一倍。
 * 学 Vibe-Research 的 `ChinaAEngine`：它的 A 股默认就是这个数，且朝对交易者不利的方向
 * 取（买贵卖便宜）。BT_SLIPPAGE=0 关掉。
 *
 * **这个值是我估的，不是测出来的**：真实滑点看那天的流动性和单子大小，回测没有逐笔
 * 成交明细，给不出实证值。所以做成可调，并把它单独列在披露里，不混进手续费假装是硬事实。
 */
export const SLIPPAGE = Number(process.env.BT_SLIPPAGE ?? 0.001);

/** 每笔本金。默认对齐线上：`MAX_SINGLE_PCT = 0.1` × 100 万 = 10 万（sizing.ts:31）。 */
export const CAPITAL_PER_TRADE = Number(process.env.BT_CAPITAL ?? 100_000);

/**
 * 一来一回的总成本占买入金额的比例。runPass 用它。
 *
 * 佣金这一段单独算是有原因的：**单笔不满 ¥5 按 ¥5 收**，固定这笔钱除以本金才是它占
 * 收益的比例，本金越大摊得越薄，所以它不是一个常数费率。
 * 触发线是单笔 2 万——当前 10 万/笔的口径下压根不触发，看不出差别，
 * 但换成小本金或以后做小额配送就会咬人，留着。
 */
export function roundTripFee(notional: number = CAPITAL_PER_TRADE): number {
  if (!(notional > 0)) return FEE + SLIPPAGE * 2;
  const commission = Math.max(notional * COMMISSION_RATE, COMMISSION_MIN) / notional;
  return commission * 2 + TRANSFER_FEE * 2 + STAMP_TAX + SLIPPAGE * 2;
}
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
  return holdOf(key as StyleId);
}
/**
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
 * 为什么是 append 不是覆盖写一个 json：三种诊断（缩量翻号 / 止跌溢价 / 资金流探路）
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
    ? `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,${LOOKBACK + 80}`
    : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,${LOOKBACK + 80},qfq`;
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

async function loadKlines(ids: string[]): Promise<Map<string, Row[]>> {
  await mkdir(CACHE, { recursive: true });
  const out = new Map<string, Row[]>();
  let done = 0;
  let notedError = false;
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
      if (!rows) {
        for (let attempt = 0; attempt < 3 && !rows; attempt += 1) {
          try {
            rows = await fetchKline(id);
            if (rows.length > 0) await writeFile(`${CACHE}/${id}.json`, JSON.stringify(rows));
          } catch (error) {
            if (attempt === 2 && !notedError) {
              notedError = true;
              console.error(`  取 ${id} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      }
      if (done < 3) process.stderr.write(`  [诊断] ${id} -> ${rows ? rows.length + " 根" : "空"}\n`);
      if (rows && rows.length > LOOKBACK) out.set(id, rows);
      done += 1;
      if (done % 50 === 0) process.stderr.write(`  已取 ${done}/${ids.length} 只\n`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return out;
}

/**
 * 给因子检验准备一套独立样本的数据（换样本 G4 用）。
 * 和 main 里主样本那套逻辑是同一份，只是抽出来能对任意一批票重跑。
 * 返回因子检验需要的全部：klines、idxOf、dates、benchOver。
 */
async function factorPrep(sampleIds: string[], capFloor: number) {
  const klines = await loadKlines(sampleIds);
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
  const dates = [...(klines.values().next().value as Row[] | undefined ?? [])].map((r) => r.date);
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
) {
  const at = (k: number) => (i - k >= 0 ? rows[i - k].c : null);
  const c = rows[i].c;
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
    prev,
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

type Signal = { buy: number; stop: number; sell: number; score: number; atClose?: boolean };

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
  return { buy, stop, sell, score: m.volRatio * 10 };
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
  return { buy, stop, sell, score: m.volRatio * 10 };
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
  return { buy, stop, sell, score: m.volRatio * 10 };
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
  return { buy, stop, sell, score: m.volRatio * 10 };
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
 * 而且前半段 t=-3.80、后半段 t=-1.68，两段同号、档位都单调。
 * 同期 5 日涨幅在两段里直接翻号（-2.35 / +1.11），那种就不能用。
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

const STRATEGIES = {
  trend: { label: "趋势回踩", fn: trend },
  breakout: { label: "放量突破", fn: breakout },
  early: { label: "启动前期", fn: early },
  reversal: { label: "反转·原版", fn: reversal },
  rev2: { label: "反转·加收阳", fn: reversal2 },
  rev3: { label: "反转·企稳版", fn: reversal3 },
  bk2: { label: "突破·早期版", fn: breakout2 },
  bk3: { label: "突破·排天量", fn: breakout3 },
  bk4: { label: "突破·早期+排天量", fn: breakout4 },
  // 中期反转要拿满 10 个交易日，不是别的策略那 8 天——因子检验里 10 天的信号最强。
  // 天数查 strategies.ts 的 STYLE_HOLD（唯一定义处），不再在这里写死 10。
  rebound: { label: "中期反转", fn: rebound, hold: holdOf("rebound") },
  // 威科夫 Spring。只在回测里跑 —— ACTIVE_STYLES 在 strategies.ts:274，
  // 那一行是实盘记账的唯一开关，本方案绝不碰它。
  spring: { label: "Spring·威科夫", fn: springBuy, hold: holdOf("rebound") },
} as const;

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
  console.log("  局限：抽样 300 只的结论外推到全市场要谨慎；回测=限价单口径，与线上现价口径有差\n");

  const uniRes = await fetch("https://qt.gtimg.cn/q=sh000001", { headers: KLINE_HEADERS });
  if (!uniRes.ok) throw new Error("连不上行情");
  void uniRes;

  // 股票池：用新浪全市场快照拿代码（东财 clist 在这台机器不通）
  const ids: string[] = [];
  // 新浪按代码升序排，bj 段会排在 sh/sz 前面，所以要多翻几页；北交所票日线太短，排除。
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    const res = await fetch(url, { headers: KLINE_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const list = (await res.json()) as { symbol?: string }[];
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

  const klines = await loadKlines(sample);
  console.log(`取到日线 ${klines.size} 只\n`);

  // 线上 tradable 硬性要求总市值 40 亿以上，回测里没有市值字段（K 线不带），
  // 所以要单独抓一份存在本地。BT_CAP=<亿> 可以把样本按市值卡一遍，
  // 用来回答「这个效应是不是只在小票上，线上那个门槛会不会正好把它滤掉」。
  // 口径的窟窿：这里用的是今天的市值，不是历史市值，多数票两年里量级没变，
  // 只能当稳健性粗检，不能当精确结论。
  const capFloor = Number(process.env.BT_CAP ?? 0);
  if (capFloor > 0) {
    let cap: Record<string, number> = {};
    try {
      cap = JSON.parse(await readFile(`${CACHE}/../cap.json`, "utf8")) as Record<string, number>;
    } catch {
      console.log("（没有 cap.json，跳过市值过滤。先跑 node 一遍抓市值的脚本。）");
    }
    let dropped = 0;
    for (const id of [...klines.keys()]) {
      const value = cap[id];
      if (value != null && value >= capFloor) continue;
      klines.delete(id);
      dropped += 1;
    }
    console.log(`市值 ${capFloor} 亿以上：剩 ${klines.size} 只，滤掉 ${dropped} 只\n`);
  }

  // 日期 -> 该票在自己数组里的下标。主循环里天天 findIndex 太慢，顺手也为了算基准。
  const idxOf = new Map<string, Map<string, number>>();
  for (const [id, rows] of klines) {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.date, i));
    idxOf.set(id, map);
  }

  const bench = await fetchKline("sh000300", true);
  const benchStart = bench.length > LOOKBACK ? bench[bench.length - LOOKBACK].c : null;
  const benchEnd = bench.length > 0 ? bench[bench.length - 1].c : null;
  const benchRet = benchStart && benchEnd ? (benchEnd - benchStart) / benchStart : 0;

  // 逐日推进：t 日收盘后选股，t+1 日成交
  const dates = [...(klines.values().next().value as Row[] | undefined ?? [])].map((r) => r.date);
  const startIdx = Math.max(0, dates.length - LOOKBACK);
  const endDate = dates[dates.length - 1] ?? "";
  const startDate = dates[startIdx] ?? "";
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

  // 流通市值缓存，给放量突破的换手率闸用。缺了要**大声说**，不能静默跳过那道闸——
  // 静默跳过的话，回测又会变回那个比线上宽松的版本，而报告里看不出来。
  // BT_TURNOVER=0 可以强制关掉这道闸，专门用来做 A/B 对照（改动前后差多少）。
  let floatCapMap: Record<string, number> = {};
  try {
    floatCapMap = JSON.parse(await readFile(`${CACHE}/../floatcap.json`, "utf8")) as Record<string, number>;
  } catch {
    floatCapMap = {};
  }
  const useTurnoverGate = Object.keys(floatCapMap).length > 0 && process.env.BT_TURNOVER !== "0";
  if (useTurnoverGate) {
    console.log(`流通市值缓存 ${Object.keys(floatCapMap).length} 条，放量突破的换手率闸已启用（≥2%）\n`);
  } else if (process.env.BT_TURNOVER === "0") {
    console.log("BT_TURNOVER=0：换手率闸被强制关掉，本次结果比线上宽松，别拿它下结论。\n");
  } else {
    console.log(
      "⚠ 没有 data/backtest/floatcap.json —— 放量突破的换手率闸（线上 ≥2%）这次没生效，\n" +
        "  回测结果会偏宽松。先跑 node scripts/build-floatcap.mjs（不联网，读本地行情缓存）。\n",
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
  const stats = { gap: 0, belowStop: 0, atClose: 0 };

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
      const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate, id);
      for (const [key, def] of Object.entries(STRATEGIES)) {
        const sig = def.fn(m, stopPct);
        if (sig) picks[key].push({ id, sig });
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
            entry: pick.sig.buy,
            exit: spotFill.price,
            reason: spotFill.reason,
            ret: spotRet,
            bench: benchOver(t, spotExitIdx, fee),
            hold: Math.max(0, spotExitIdx - tIdx),
            ref: klineRef(CACHE, pick.id, rows[tIdx].date),
          });
          continue;
        }

        // 限价单撮合。挂在 P，第二天只有两种成交方式：
        //   开盘价就不高于 P —— 开盘那一刻直接成交，拿到的是开盘价（比挂单价好）
        //   盘中最低价碰到 P —— 按 P 成交
        // 只判断「最低价碰到」会把跳空低开、全天没回到 P 上方的票记成「在 P 成交」，
        // 而那个价位当天压根没出现过。用 BT_FILL 对比三种口径：
        //   a = 老口径（一律按挂单价，偏保守，会凭空多付钱）
        //   b = 真实口径（跳空按开盘价成交）  ← 默认
        //   c = 只认「当天确实在挂单价上方成交过」的，跳空的那批直接不算
        const open = bar.o > 0 ? bar.o : null;
        let entry: number | null = null;
        if (fillMode === "a") {
          if (bar.l <= pick.sig.buy) entry = pick.sig.buy;
        } else if (fillMode === "b") {
          if (open != null && open <= pick.sig.buy) entry = open;
          else if (bar.l <= pick.sig.buy) entry = pick.sig.buy;
        } else if (bar.l <= pick.sig.buy && (bar.h <= 0 || bar.h >= pick.sig.buy)) {
          entry = pick.sig.buy;
        }
        if (entry == null) continue;
        // 跳空把价格直接开到止损下方：买是买到了，但拿到手的价已经在止损下面，
        // 这不是策略设想的那笔交易（止损会立刻被打掉，价格没法确定），干脆不算。
        if (entry <= pick.sig.stop) {
          stats.belowStop += 1;
          continue;
        }
        if (open != null && open <= pick.sig.buy) stats.gap += 1;
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
  console.log("策略            笔数   胜率   平均收益   同期全池    超额    t值   跑赢   平均持有  连亏天数  回撤");
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
    // 单笔超额波动很大，光看均值会自己骗自己。算个 t 值：
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
  }
  console.log("-".repeat(110));
  }

  /**
   * 落盘用的日度序列：那天所有平仓的等权平均收益 + 笔数。
   * 和 byDay 同源（byDay 只给数值，这里要带日期和笔数）。
   */
  function dayRowsOf(trades: Trade[]): { date: string; ret: number; n: number }[] {
    const bucket = new Map<string, { sum: number; n: number }>();
    for (const t of trades) {
      // 按**卖出日**聚合：收益是那天落袋的。按信号日会把不同平仓日的收益挤到同一天，
      // 累计曲线和月度柱子全错（2026-10-14 实测差 20 倍）。
      const row = bucket.get(t.exitDate) ?? { sum: 0, n: 0 };
      row.sum += t.ret;
      row.n += 1;
      bucket.set(t.date, row);
    }
    return [...bucket.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, row]) => ({ date, ret: row.sum / row.n, n: row.n }));
  }

  /** 同日期的基准（同期全池）平均，给超额曲线用。 */
  function benchRowsOf(trades: Trade[]): { date: string; ret: number; n: number }[] {
    const bucket = new Map<string, { sum: number; n: number }>();
    for (const t of trades) {
      const row = bucket.get(t.exitDate) ?? { sum: 0, n: 0 };
      row.sum += t.bench;
      row.n += 1;
      bucket.set(t.date, row);
    }
    return [...bucket.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, row]) => ({ date, ret: row.sum / row.n, n: row.n }));
  }

  /**
   * 每天一个数：那天卖出的所有仓位，当天收益率的平均。
   *
   * 是「平均」不是「总和」——一天卖出十笔就等于十个满仓，可实际上它们是十个
   * 等权的小仓位，组合的当日收益是它们的平均。之前按总和算，一天能算出 +244%，
   * 净值一年冲到二十几倍，回撤动辄 80% 以上，闸门和停手线完全没法比。
   */
  function byDay(trades: Trade[]): number[] {
    const bucket = new Map<string, { sum: number; n: number }>();
    for (const t of trades) {
      // 按**卖出日**聚合（2026-10-14 修）：收益是卖出日落袋的。原来按 date（信号日）
      // 聚合，把还没实现的收益算到信号日——连亏天数和回撤因此偏乐观/偏悲观，
      // 而且和线上闸门（按实际盈亏日）不是同一个口径。
      const row = bucket.get(t.exitDate) ?? { sum: 0, n: 0 };
      row.sum += t.ret;
      row.n += 1;
      bucket.set(t.date, row);
    }
    return [...bucket.values()].map((row) => row.sum / row.n);
  }

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
   * t 值按「每天一个最高档减最低档」算，这样不会被某几天的暴涨暴跌带偏。
   */
  if (process.env.BT_FACTOR === "1") {
    const N = Number(process.env.BT_N ?? 3);
    const buckets = Number(process.env.BT_BUCKETS ?? 5);
    // 待验队列因子（AI/人工预登记、还没淘汰的）附加在注册表后面一起跑。
    // 追加在尾部而不是插中间：后面 BT_DIAG 分支用 FACTORS.findIndex 定位下标，
    // 追加能保持下标不变。淘汰（tombstone）的由 loadQueueFactors 内部跳过。
    const queueFactors = await loadQueueFactors();
    const factors = [...FACTORS, ...queueFactors];
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
          const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate, id);
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

    const mid = Math.floor((startIdx + dates.length - 2) / 2);
    const fullDaily = buildDaily(klines, idxOf, dates, benchOver, startIdx, dates.length - N);
    const full = analyzeFactors(fullDaily, factorCount, buckets);
    const first = analyzeFactors(buildDaily(klines, idxOf, dates, benchOver, startIdx, Math.min(mid, dates.length - N)), factorCount, buckets);
    const second = analyzeFactors(buildDaily(klines, idxOf, dates, benchOver, mid, dates.length - N), factorCount, buckets);

    // G4 换样本：自动加载错开一位的一批票，跑同一套检验
    const step = Math.max(1, Math.floor(ids.length / SAMPLE));
    const resampleIds = ids.filter((_, i) => (i + offsetVal + 1) % step === 0).slice(0, SAMPLE);
    const rp = await factorPrep(resampleIds, capFloor);
    const rStart = Math.max(0, rp.dates.length - LOOKBACK);
    const resample = analyzeFactors(buildDaily(rp.klines, rp.idxOf, rp.dates, rp.benchOver, rStart, rp.dates.length - N), factorCount, buckets);

    const nTested = factorCount;
    const totalDays = full.reduce((s, r) => Math.max(s, r.nDays), 0);
    /**
     * DSR（学 Vibe-Trading 的 deflated sharpe）：把「试了 nTested 个因子、运气最好
     * 的那个该有多显著」当基准线，回答「这个 t 值是不是搜出来的」。
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
      const g1 = gateMonotonic(run.bucketMeans, factor.direction);
      const g2 = gateT(run.t);
      const g3 = gateHalves(first[f], second[f]);
      const g4 = gateResample(run, resample[f]);
      const g5 = gateBonferroni(run.t, nTested);
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
          /** 样本量：换 BT_SAMPLE / offset 跑的判决，AI 读账时能分辨证据强度。 */
          universe: sample.length,
          nDays: run.nDays,
          meanSpread: run.meanSpread,
          t: run.t,
          topBlockedRatio: run.topBlockedRatio,
          bucketMeans: run.bucketMeans,
          resampleSpread: resample[f].meanSpread,
          resampleT: resample[f].t,
          /**
           * 前后两段各自的 spread / t。以前算完就丢了，导致 G3（两段同号）在页面
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
          gates: { g1: g1.pass, g2: g2.pass, g3: g3.pass, g4: g4.pass, g5: g5.pass, g6: g6.pass },
          nTested,
          /** spread 分布形状 + 运气线校正（Vibe-Trading DSR）。旧批次没有。 */
          spreadSkew: run.spreadSkew,
          spreadKurt: run.spreadKurt,
          dsr: dsrInfo,
        }),
      );
      // 队列因子（f 排在注册表后面）记下判决，整轮跑完一起回写队列状态。
      if (f >= FACTORS.length) {
        queueVerdicts.push({
          id: factor.id,
          passed: [g1, g2, g3, g4, g5, g6].every((g) => g.pass),
          at,
          // 死因档案用：败在哪几关。过关的为空数组（不是没测，是 6 关全过）。
          failedGates: [g1, g2, g3, g4, g5, g6].flatMap((g, i) => (g.pass ? [] : [`g${i + 1}`])),
          // DSR 是展示层证据，过关失败都存档——回答「这个因子是不是搜出来的」。
          dsr: dsrInfo ?? undefined,
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
      const fShrink = FACTORS.findIndex((f) => f.id === "shrinkDays");
      const fD60 = FACTORS.findIndex((f) => f.id === "d60");
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

        // 精确到交易日：5 日滚动平均滤掉单日噪声，定位翻号（spread>0）的日期段
        const series = diag.spreadSeries;
        const win = 5;
        const smooth = series.map((x, k) => {
          const slice = series.slice(Math.max(0, k - win + 1), k + 1);
          return { date: dates[startIdx + x.idx], spread: slice.reduce((s, y) => s + y.spread, 0) / slice.length };
        });
        console.log("\n精确到交易日（5 日滚动平均后的顶-底 spread，只列正的=翻号段；同期全池=这段全市场等权涨跌）：");
        // 翻号段也要落盘——它们在终端闪一下就没了，而「13 段零散、不是一整段」
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
      const fShrink = FACTORS.findIndex((f) => f.id === "shrinkDays");
      const fChg = FACTORS.findIndex((f) => f.id === "chg");
      const fD60 = FACTORS.findIndex((f) => f.id === "d60");
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

        // 翻号段（缩量整体失效的时段）里，止跌组是否还扛得住
        const diagDays = diagnoseShrinkDays(fullDaily, fShrink, fD60, buckets);
        const win = 5;
        const smooth = diagDays.spreadSeries.map((x, k) => {
          const s = diagDays.spreadSeries.slice(Math.max(0, k - win + 1), k + 1);
          return { date: dates[startIdx + x.idx], spread: s.reduce((a, y) => a + y.spread, 0) / s.length };
        });
        console.log("\n翻号段（5 日滚动 spread>0）里，止跌 vs 不止跌：");
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
        if (rows === 0) console.log("  （没有翻号段）");
        console.log("  判读：止跌溢价 t≥2 且翻号段里止跌组仍显著为正 → 止跌条件能把失效滤掉。");

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
    console.log("判据：|t|<2=没测出；两段翻号=不能用；Bonferroni 后不显著=降级；顶档被挡过半=不可交易。");
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
    console.log("出场原因拆解：");
    for (const key of Object.keys(STRATEGIES)) breakdown(results, key);
    console.log("");
    console.log(
      `入场撮合（口径 ${fillMode}）：跳空低开成交 ${fillStats.gap} 笔，开在止损下方不算 ${fillStats.belowStop} 笔`,
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
