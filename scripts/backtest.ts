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
 * 2026-10-06 补上一条：放量突破的**换手率 ≥ 2%** 这道闸以前也缺，现在用
 * 流通市值反推补上了（成交额 ÷ 流通市值，和腾讯的 hsl 同口径，吻合率 99.8%）。
 * 跑 `node scripts/build-floatcap.mjs` 生成缓存；没有缓存时会在开头大声提示
 * 这道闸没生效，不会静默地退回宽松口径。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { exitFill } from "@/lib/market/journal-book";
import { boardLimit } from "@/lib/market/model";
import type { Bar } from "@/lib/market/types";

/** 回测多长。250 个交易日约等于一年。 */
const LOOKBACK = 250;
/** 抽多少只股票。全市场五千多只全拉太慢，抽样已经能看出方向。 */
const SAMPLE = Number(process.env.BT_SAMPLE ?? 300);
/** 每套策略每天最多买几只，和线上一致。 */
const MAX_POSITIONS = 10;
/** 一来一回的手续费，和线上一致。 */
const FEE = 0.00102;
const CACHE = "data/backtest/kline";
const KLINE_HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com/" };

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

/** 只用第 i 天及之前的数据算指标。这是「无前视」的落地点。 */
function metrics(rows: Row[], i: number, floatCap: number | null = null, turnoverGateOn = false) {
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
  return {
    c,
    prev,
    open: rows[i].o,
    low: rows[i].l,
    prevLow: i - 1 >= 0 ? rows[i - 1].l : rows[i].l,
    chg,
    d5: pct(at(5)),
    d20: pct(at(20)),
    d60: pct(at(60)),
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
  };
}

function avg(list: number[]): number {
  if (list.length === 0) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
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
 * 中期反转：买 60 日里跌得最惨的一批，拿 10 天。
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
  // 中期反转要拿满 10 个交易日，不是别的策略那 8 天——因子检验里 10 天的信号最强
  rebound: { label: "中期反转", fn: rebound, hold: 10 },
} as const;

type Trade = {
  id: string;
  date: string;
  entry: number;
  exit: number;
  reason: string;
  ret: number;
  /** 同一时间段里，抽样池全体股票等权持有的收益。ret 减去它才是选股本身带来的。 */
  bench: number;
  hold: number;
};

async function main() {
  console.log("无前视回测：只用在 t 日收盘时已知的信息，t+1 日按限价单成交\n");

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
  function benchOver(fromIdx: number, toIdx: number): number {
    let acc = 1;
    for (let i = fromIdx + 1; i <= toIdx && i < uniRet.length; i += 1) acc *= 1 + uniRet[i];
    return acc - 1;
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
  // 入场撮合口径，三选一；默认 b（跳空按开盘价成交）
  const fillMode = process.env.BT_FILL ?? "b";
  let fillStats = { gap: 0, belowStop: 0 };
  function bullishAt(date: string): boolean {
    const i = bench.findIndex((r) => r.date === date);
    if (i < 20) return false;
    const ma20 = avg(bench.slice(i - 19, i + 1).map((r) => r.c));
    return bench[i].c > ma20;
  }

  function runPass(stopPct?: number): Record<string, Trade[]> {
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
      const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate);
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
            key === "rebound" ? Number(process.env.BT_HOLD ?? 10) : undefined,
          );
          if (!spotFill) continue;
          const spotRet = (spotFill.price - pick.sig.buy) / pick.sig.buy - FEE;
          const spotExitIdx = idxOf.get(pick.id)?.get(spotFill.date) ?? -1;
          results[key].push({
            id: pick.id,
            date: rows[tIdx].date,
            entry: pick.sig.buy,
            exit: spotFill.price,
            reason: spotFill.reason,
            ret: spotRet,
            bench: benchOver(t, spotExitIdx),
            hold: Math.max(0, spotExitIdx - tIdx),
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
          key === "rebound" ? Number(process.env.BT_HOLD ?? 10) : undefined,
        );
        if (!fill) continue;
        const ret = (fill.price - entry) / entry - FEE;
        const exitIdx = idxOf.get(pick.id)?.get(fill.date) ?? -1;
        const hold = exitIdx - nextIdx;
        results[key].push({
          id: pick.id,
          date: bar.date,
          entry,
          exit: fill.price,
          reason: fill.reason,
          ret,
          bench: benchOver(t + 1, datePos.get(fill.date) ?? t + 1),
          hold,
        });
      }
    }
  }
  fillStats = stats;
  return results;
  }

  function report(results: Record<string, Trade[]>, title: string) {
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
   * 每天一个数：那天卖出的所有仓位，当天收益率的平均。
   *
   * 是「平均」不是「总和」——一天卖出十笔就等于十个满仓，可实际上它们是十个
   * 等权的小仓位，组合的当日收益是它们的平均。之前按总和算，一天能算出 +244%，
   * 净值一年冲到二十几倍，回撤动辄 80% 以上，闸门和停手线完全没法比。
   */
  function byDay(trades: Trade[]): number[] {
    const bucket = new Map<string, { sum: number; n: number }>();
    for (const t of trades) {
      const row = bucket.get(t.date) ?? { sum: 0, n: 0 };
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
    const getters: { name: string; get: (m: ReturnType<typeof metrics>) => number | null }[] = [
      { name: "当日涨幅", get: (m) => m.chg },
      { name: "5日涨幅", get: (m) => m.d5 },
      { name: "20日涨幅", get: (m) => m.d20 },
      { name: "60日涨幅", get: (m) => m.d60 },
      { name: "量比", get: (m) => m.volRatio },
      { name: "量能萎缩", get: (m) => m.volShrink },
      { name: "成交额", get: (m) => m.amountWan },
      { name: "股价", get: (m) => m.c },
    ];
    // 每天一份：[各因子取值, 未来 N 天超额]
    const daily: { vals: (number | null)[]; ex: number }[][] = [];
    // 前后半段分开跑：只在其中一段好看的因子，多半是那段行情碰巧
    const half = process.env.BT_HALF;
    const mid = Math.floor((startIdx + dates.length - 2) / 2);
    const from = half === "second" ? mid : startIdx;
    const to = half === "first" ? Math.min(mid, dates.length - N) : dates.length - N;
    for (let t = from; t < to; t += 1) {
      const today: { vals: (number | null)[]; ex: number }[] = [];
      for (const [id, rows] of klines) {
        const idx = idxOf.get(id)?.get(dates[t]);
        if (idx == null || idx < 61) continue;
        const nIdx = idxOf.get(id)?.get(dates[t + 1]);
        const xIdx = idxOf.get(id)?.get(dates[t + N]);
        if (nIdx == null || xIdx == null) continue;
        // 信号是 t 日收盘才有的，最早只能次日开盘买
        const inPrice = rows[nIdx].o;
        const outPrice = rows[xIdx].c;
        if (!(inPrice > 0) || !(outPrice > 0)) continue;
        const m = metrics(rows, idx, useTurnoverGate ? floatCapMap[id] ?? null : null, useTurnoverGate);
        today.push({ vals: getters.map((g) => g.get(m)), ex: outPrice / inPrice - 1 - benchOver(t + 1, t + N) });
      }
      daily.push(today);
    }
    console.log(
      `因子检验${half ? `（${half} 段）` : ""}：${daily.length} 个交易日 × 每天约 ${Math.round(daily.reduce((s, d) => s + d.length, 0) / Math.max(1, daily.length))} 只，` +
        `t 日收盘排序，次日开盘买入、持有 ${N} 天后按收盘卖出\n`,
    );
    // 默认分五档。BT_BUCKETS=10 可以看更细——「越跌越好」到底是不是一直成立到
    // 最惨的那一小撮。极端档如果塌了，策略就得给跌幅设个下限，不能无脑买最惨的。
    const buckets = Number(process.env.BT_BUCKETS ?? 5);
    const head = getters[0].name.padEnd(10);
    console.log(
      head + Array.from({ length: buckets }, (_, b) => `${b === 0 ? "最低" : b === buckets - 1 ? "最高" : "第" + (b + 1)}`.padStart(9)).join("") + "   最高-最低    t值",
    );
    console.log("-".repeat(84 + (buckets - 5) * 9));
    for (let f = 0; f < getters.length; f += 1) {
      const sum = new Array(buckets).fill(0);
      let days = 0;
      const spreads: number[] = [];
      for (const today of daily) {
        const usable = today.filter((r) => r.vals[f] != null);
        if (usable.length < buckets * 10) continue;
        usable.sort((a, b) => (a.vals[f] as number) - (b.vals[f] as number));
        const q = Math.floor(usable.length / buckets);
        const meanOf = (slice: { ex: number }[]) => slice.reduce((s, r) => s + r.ex, 0) / slice.length;
        const low = usable.slice(0, q);
        const high = usable.slice(usable.length - q);
        for (let b = 0; b < buckets; b += 1) {
          const slice = usable.slice(b * q, b === buckets - 1 ? usable.length : (b + 1) * q);
          if (slice.length > 0) sum[b] += meanOf(slice);
        }
        spreads.push(meanOf(high) - meanOf(low));
        days += 1;
      }
      const each = sum.map((s) => s / Math.max(1, days));
      const meanSpread = spreads.reduce((s, v) => s + v, 0) / Math.max(1, spreads.length);
      const sd =
        spreads.length > 1
          ? Math.sqrt(spreads.reduce((s, v) => s + (v - meanSpread) ** 2, 0) / (spreads.length - 1))
          : 0;
      const tStat = sd > 0 ? meanSpread / (sd / Math.sqrt(spreads.length)) : 0;
      const cells = each.map((v) => `${(v >= 0 ? "+" : "") + (v * 100).toFixed(2)}%`.padStart(9)).join("");
      console.log(
        getters[f].name.padEnd(10) +
          cells +
          `${(meanSpread >= 0 ? "+" : "") + (meanSpread * 100).toFixed(2)}%`.padStart(11) +
          tStat.toFixed(2).padStart(8),
      );
    }
    console.log("-".repeat(84 + (buckets - 5) * 9));
    console.log("\n注：这是等权、不含手续费的粗检；t 值不到 2 就等于这个因子没测出预测力。");
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
    report(results, process.env.BT_HALF ? `区间：${process.env.BT_HALF} 段` : "");
    console.log("出场原因拆解：");
    for (const key of Object.keys(STRATEGIES)) breakdown(results, key);
    console.log("");
    console.log(
      `入场撮合（口径 ${fillMode}）：跳空低开成交 ${fillStats.gap} 笔，开在止损下方不算 ${fillStats.belowStop} 笔`,
    );
    console.log(`同期沪深 300 买入持有：${(benchRet * 100).toFixed(1)}%（作为参照）`);
  }
  console.log("\n注：单笔收益率等权累加，不是复利；样本含幸存者偏差，实际会差一些。");
}

await main();
