/**
 * 这个文件是干什么的：
 * 读本地日线缓存（`data/backtest/kline/*.json`），给「区间统计 / RS 榜 / 席位战绩 /
 * 前瞻回验」这几个新页面共用。**只读本地文件，不联网。**
 *
 * 你需要知道的：
 * - 一只票一个文件，代码是带前缀的 id（sh600000 / sz000001 / bj920000）。
 * - 交易日不是从日历推的，是**数出来的**：某一天有 3000 只以上有成交，才算交易日。
 *   这样停牌、脏数据、节假日都不会把日子算歪。
 * - 全部读进内存大约 500MB 级的解析压力，但只在构建脚本里跑一次，页面读的是产物。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Bar = { date: string; o: number; h: number; l: number; c: number; v: number };

const KLINE_DIR = "data/backtest/kline";

/** 一天至少这么多只票有数据，才算真交易日。低于这个数是停牌/脏数据，丢掉。 */
const MIN_BARS_PER_DAY = 3000;

export function loadAllKlines(): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const f of readdirSync(KLINE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const code = f.slice(0, -5);
    try {
      const bars = JSON.parse(readFileSync(join(KLINE_DIR, f), "utf8")) as Bar[];
      if (Array.isArray(bars) && bars.length > 0) out.set(code, bars);
    } catch {
      // 单个文件坏了不影响整体；坏文件数由调用方对比文件总数自己发现
    }
  }
  return out;
}

/** 数出来的交易日，升序。 */
export function tradingDates(all: Map<string, Bar[]>): string[] {
  const count = new Map<string, number>();
  for (const bars of all.values()) {
    for (const b of bars) count.set(b.date, (count.get(b.date) ?? 0) + 1);
  }
  return [...count.entries()]
    .filter(([, n]) => n >= MIN_BARS_PER_DAY)
    .map(([d]) => d)
    .sort();
}

/** 把每只票的 bars 按日期建索引，便于按日取值。 */
export function indexByDate(bars: Bar[]): Map<string, Bar> {
  const m = new Map<string, Bar>();
  for (const b of bars) m.set(b.date, b);
  return m;
}

/**
 * 取某只票在某个日期之前（含）最近的 n 根。
 * 返回的最后一根如果日期不等于 date，说明该票那天没交易（停牌），调用方要自己判。
 */
export function tailUpTo(bars: Bar[], date: string, n: number): Bar[] {
  let lo = 0;
  let hi = bars.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 0) return [];
  return bars.slice(Math.max(0, idx - n + 1), idx + 1);
}

/** 某日之后第 k 根（k=1 是次日）。不存在返回 null。 */
export function barAfter(bars: Bar[], date: string, k: number): Bar | null {
  const i = bars.findIndex((b) => b.date === date);
  if (i < 0) return null;
  return bars[i + k] ?? null;
}

/** A 股涨跌停阈值：主板 10%，创业板/科创板 20%，北交所 30%，ST 5%（无 ST 标记，另说）。 */
export function limitPct(code: string): number {
  const bare = code.replace(/^(sh|sz|bj)/, "");
  if (code.startsWith("bj")) return 0.295;
  if (bare.startsWith("300") || bare.startsWith("301") || bare.startsWith("688") || bare.startsWith("689")) return 0.195;
  return 0.095;
}
