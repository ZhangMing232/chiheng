/**
 * 这个文件是干什么的：
 * 把「策略 spec」接到回测引擎上——让基因组轨道提出来的 spec 能像普通策略一样
 * 跑回测、拿聚类 t 判决，而不是只躺在 data/strategy-genome.json 里没人判。
 *
 * 为什么需要它（用户原话）：「每一次失败总结出来的是一个更新的策略或者全新的策略」。
 * 挑战者通道在架构上改不了「买什么」；基因组轨道能改，但改完得有人判它值不值。
 * 这个文件就是那个「判」的入口。
 *
 * 你需要知道的（纪律）：
 * 1. **口径必须一一对得上，不许拿别的字段顶替。** 每个 spec 变量在回测里的来源都写在
 *    `FIELD_SOURCES` 表里。回测取不到的字段（历史主力净流入）→ spec 用到它就**拒绝跑**，
 *    写清缺哪个字段，而不是悄悄换个字段算出一个「看起来能跑」的结果。
 * 2. **prev 不取回测的 m.prev。** 回测里 `metrics().prev` 是「信号日收盘价」（基准口径），
 *    而 spec 语境下的 prev 是「昨收」= price/(1+chg/100)。两者差一天，混用会整体错位一天。
 *    这里统一让 quoteFeatures 从 price+chg 现场算 prev，和线上完全一致。
 * 3. **成交方向由买价与信号日收盘的关系决定**（和线上 breakout/limit 的规矩一样）：
 *    buy > 收盘 → stop（追涨，次日开盘越过买价成交）；buy < 收盘 → limit（等回踩）；
 *    buy == 收盘 → atClose（现价单，当日收盘成交）。
 * 4. **市值为今日快照**（cap.json），历史总市值没有——和 value 回测变体同一个已知近似。
 * 5. 纯函数 + 零网络依赖，可单测。回测脚本（scripts/backtest.ts）只负责接线。
 */

import type { StrategySpec } from "./strategies.ts";
import { quoteOrderForSpec } from "./strategies.ts";
import { SPEC_EXPR_VARS, type SpecQuote } from "./factor-expr.ts";
/**
 * spec 表达式里每个变量在回测中的来源。**这张表就是口径说明书**——
 * 改映射前先想清楚是不是同一个东西。
 *
 * unavailable 的字段 = 回测根本没有这个数据序列，用到就拒跑（见 SPEC_UNAVAILABLE）。
 */
export const FIELD_SOURCES: Record<string, { source: string; note?: string }> = {
  price: { source: "metrics().c", note: "信号日收盘价" },
  prev: { source: "price/(1+chg/100) 现场算", note: "昨收，和线上同口径；不用回测的 m.prev（那是信号日收盘，差一天）" },
  chg: { source: "metrics().chg", note: "当日涨跌幅" },
  pe: { source: "baostock peTTM 逐日序列" },
  pb: { source: "baostock pbMRQ 逐日序列" },
  cap: { source: "cap.json 今日快照", note: "已知近似：历史总市值没有" },
  floatCap: { source: "floatcap.json 今日快照", note: "已知近似" },
  turnover: { source: "成交额÷流通市值 反推", note: "和腾讯 hsl 同口径；缺流通市值时为 null（不是 0）" },
  volRatio: { source: "metrics().volRatio", note: "当日量÷5 日均量" },
  amp: { source: "当日 (h-l)/c", note: "仓库内 amp20 的同日口径；腾讯 zf 用昨收做分母，略有差异" },
  d5: { source: "metrics().d5" },
  d10: { source: "metrics().d10" },
  d20: { source: "metrics().d20" },
  d60: { source: "metrics().d60" },
  ytd: { source: "（无）", note: "回测窗口多起于本年内，基准取不到；见 SPEC_UNAVAILABLE.ytd" },
  inflow: { source: "（无）", note: "回测没有历史主力净流入序列" },
  amount: { source: "metrics().amountWan", note: "成交量×100×收盘价 折算，与实际成交额略有出入" },
};

/** 回测拿不到、spec 用到就必须拒跑的变量。 */
export const SPEC_UNAVAILABLE: Record<string, string> = {
  inflow: "回测没有历史主力净流入序列（mainFlow 也不给），用 inflow 会算出一个假信号",
  ytd:
    "回测窗口起点多在本年之内，算不出「上一年最后一个收盘」这个基准；只有年初那一小段有值，" +
    "会让样本随月份漂移（同一套 spec 1 月和 9 月选出的票不是一回事）。按本仓库「宁可拒跑不勉强跑」的规矩拒掉",
};

/** 回测里一行指标（scripts/backtest.ts 的 metrics() 产物）的结构子集。 */
export type SpecBacktestRow = {
  c: number;
  chg: number;
  pe: number | null;
  pb: number | null;
  cap: number | null;
  floatCap: number | null;
  turnover: number | null;
  volRatio: number;
  /** 当日振幅（%），metrics().ampDay */
  ampDay: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d60: number | null;
  /** 年初至今涨跌幅（%）——回测不给（见 SPEC_UNAVAILABLE.ytd），恒 undefined。 */
  ytd?: number | null;
  amountWan: number;
  /** 历史 ST 标记（baostock 序列），null = 那天不知道 */
  isST: boolean | null;
};

/** 回测里的信号（和 scripts/backtest.ts 的 Signal 同形）。 */
export type SpecSignal = {
  buy: number;
  stop: number;
  sell: number;
  score: number;
  atClose?: boolean;
  fill?: "stop" | "limit";
};

/** 把 spec 表达式里用到的变量名抠出来（去重）。 */
export function specVarsUsed(spec: StrategySpec): string[] {
  const srcs = [...spec.select, spec.rankBy, spec.pricing.buyExpr, spec.pricing.sellExpr, spec.pricing.stopExpr].filter(
    (x): x is string => typeof x === "string",
  );
  const found = new Set<string>();
  for (const src of srcs) {
    for (const id of src.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []) {
      if ((SPEC_EXPR_VARS as readonly string[]).includes(id)) found.add(id);
    }
  }
  return [...found].sort();
}

/**
 * 这套 spec 能不能在回测里跑？不能的话，缺哪个字段、为什么。
 * 返回 missing 列表——调用方必须据此拒绝跑，不许降级。
 */
export function specBacktestReady(spec: StrategySpec): { ready: boolean; missing: string[] } {
  const used = specVarsUsed(spec);
  const missing = used.filter((v) => SPEC_UNAVAILABLE[v]).map((v) => `${v}（${SPEC_UNAVAILABLE[v]}）`);
  return { ready: missing.length === 0, missing };
}

/** 把回测的一行指标映射成 spec 语境下的 Quote。取不到的字段给 null，不给 0。 */
export function metricRowToQuote(m: SpecBacktestRow, id: string): SpecQuote {
  return {
    id,
    // 回测没有股票名。ST 判定靠 baostock 的 isST 序列——名字里塞 "ST" 是为了让
    // boardLimit() 判出 5% 涨跌停（它只看 id + name 里有没有 ST/退）。
    name: m.isST ? "ST" : id,
    price: m.c,
    chg: m.chg,
    pe: m.pe,
    pb: m.pb,
    cap: m.cap,
    floatCap: m.floatCap,
    turnover: m.turnover,
    volRatio: m.volRatio,
    amp: m.ampDay,
    d5: m.d5,
    d10: m.d10,
    d20: m.d20,
    d60: m.d60,
    ytd: m.ytd ?? null,
    inflow: null, // 回测没有这个序列，恒 null
    amount: m.amountWan,
    st: m.isST === true,
  };
}

/**
 * 回测能判的变量清单 = 白名单去掉「回测取不到」的。
 * 提 spec 时只能用这些——用了别的，回测判不了，这条 spec 就永远停在 proposed，
 * 等于白提。**在提议端就拒掉，比事后发现判不了便宜得多。**
 */
export const SPEC_JUDGEABLE_VARS: readonly string[] = SPEC_EXPR_VARS.filter((v) => !SPEC_UNAVAILABLE[v]);

/**
 * 从回测数据目录取一个候选 spec 接到回测上。
 * 取不到、或 spec 用到了回测没有的字段 → **抛错拒跑**（不降级、不换字段凑数）。
 * 动态 import 是为了不把 strategy-genome 的 node 依赖拖进浏览器侧的模块图。
 */
export async function loadGenomeSpec(specId: string): Promise<{ spec: StrategySpec; label: string; hold: number }> {
  const { readGenome } = await import("./strategy-genome.ts");
  const file = await readGenome();
  const found = file.list.find((x) => x.id === specId);
  if (!found) {
    const ids = file.list.map((x) => x.id).join(", ");
    throw new Error(`基因组里没有 id「${specId}」这个 spec（现有：${ids || "无"}）`);
  }
  const ready = specBacktestReady(found);
  if (!ready.ready) {
    throw new Error(`spec「${specId}」用到了回测取不到的字段：${ready.missing.join("；")}——按规矩拒跑，不换字段凑数`);
  }
  return { spec: found, label: `基因组·${found.name}`, hold: found.holdDays };
}

/**
 * 用 spec 给回测的一行算信号。返回 null = 这只票不进这个策略的候选。
 * 口径和线上一致：quoteOrderForSpec 负责 tradable + 选股条件 + 三价合法性。
 */
export function specBacktestSignal(spec: StrategySpec, m: SpecBacktestRow, id: string): SpecSignal | null {
  const quote = metricRowToQuote(m, id);
  const order = quoteOrderForSpec(spec, quote);
  if (!order) return null;
  const close = m.c;
  // 成交方向：买价高于信号日收盘 = 追涨（stop），低于 = 等回踩（limit），相等 = 现价单。
  if (order.buy > close + 1e-6) return { buy: order.buy, stop: order.stop, sell: order.sell, score: order.score, fill: "stop" };
  if (order.buy < close - 1e-6) return { buy: order.buy, stop: order.stop, sell: order.sell, score: order.score, fill: "limit" };
  return { buy: order.buy, stop: order.stop, sell: order.sell, score: order.score, atClose: true };
}
