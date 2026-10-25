/**
 * 这个文件是干什么的：
 * 估值历史（PE_TTM / PB / PS 日序列）的读取与分位计算。数据来自 baostock，
 * 由 `scripts/fetch-pe-history.py` 落盘成 `data/fundamentals/pe-<code>.json`。
 *
 * 加它的原因写在这里，免得以后被当成可有可无：2026-10-12 做「个股研判」页时发现，
 * 赤轨给得出 PE 的**绝对值**，给不出「这个 PE 在它自己历史上排第几」。
 * 一句「19 倍」在历史 90 分位和 10 分位完全是两件事——**只给绝对值等于让人猜**。
 *
 * 你需要知道的（纪律）：
 * 1. **分工照 Vibe-Research**：取数层零派生计算。Python 脚本只负责把原始序列落盘，
 *    分位在这个文件算。好处是任意一个成品数字都能反推到它用了哪一列。
 * 2. **分位口径写死在这里**：`percentileRank` 的回答是
 *    「历史上有百分之多少的交易日**比现在便宜**」，范围 [0,100]，越大越贵。
 *    用严格小于（`<`）计数，等于当前值的不算便宜。
 *    最新那个交易日自身也在分母里——这是 rolling 口径，不是「除今天之外的历史」。
 * 3. **样本太少不给数**。少于 `MIN_POINTS` 个有效点返回 null，不是返回 50 假装「中间」。
 *    样本不够就说不够，这比一个看起来合理的假数字强。
 * 4. 纯逻辑不碰 fs（除了 `loadValuationHistory` 这一个读文件的函数），好单测。
 *
 * ⚠️ **不要顶层 import node 内置模块**（2026-10-25 实测，第三次踩）：
 * 本文件被 research / debate / strategies 路由**静态引用**，会进客户端
 * bundle。vite 把 `import { readFile } from "node:fs/promises"` 转成
 * **顶层解构**浏览器空壳桩，模块一求值就抛「Module externalized for
 * browser compatibility」——**整站 hydration 崩，页面能看、所有按钮
 * 按不动**（SSR 正常、测试全绿；dev 模式下 routeTree 静态引全部路由，
 * 任何路由链上的雷都炸全站）。规矩同 quotes.functions.ts：node 内置
 * 一律函数内动态 import；拼路径用 POSIX join。
 */

const fsApi = () => import("node:fs/promises");

/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

/** 一个交易日的估值快照。字段名沿用 baostock 原始列，不做重命名——方便反查。 */
export type ValuationPoint = {
  date: string;
  close: number | null;
  peTTM: number | null;
  pbMRQ: number | null;
  psTTM: number | null;
  turn: number | null;
  isST: boolean;
};

export type ValuationHistory = {
  code: string;
  symbol: string;
  source: string;
  adjust: string;
  fetchedAt: string;
  window: { from: string; to: string };
  counts: { raw: number; traded: number; halted: number };
  series: ValuationPoint[];
};

/** 算分位至少要多少个交易日。少于此值不给数。 */
export const MIN_POINTS = 60;

/**
 * 「历史上有百分之多少的交易日比现在便宜」。
 *
 * 无效值（缺失 / 非有限数）直接从样本里剔除，不补 0——亏损股的 PE 是空值，
 * 补 0 会被当成「历史上极端便宜」，把分位压到 0%，方向正好反了。
 */
export function percentileRank(values: (number | null)[], value: number): number | null {
  const usable = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (usable.length < MIN_POINTS) return null;
  if (!Number.isFinite(value)) return null;
  const cheaper = usable.filter((v) => v < value).length;
  return (cheaper / usable.length) * 100;
}

export type ValuationPosition = {
  /** 最新交易日的 PE_TTM 分位。null = 样本不够或没有序列 */
  peRank: number | null;
  pbRank: number | null;
  latest: ValuationPoint | null;
  /** 参与计算的有效点数 */
  points: number;
  window: { from: string; to: string } | null;
  fetchedAt: string;
};

/** 把一条历史序列变成「现在站在历史的什么位置」。 */
export function valuationPosition(history: ValuationHistory | null): ValuationPosition | null {
  if (!history || history.series.length === 0) return null;
  const latest = history.series[history.series.length - 1] ?? null;
  const peSeries = history.series.map((p) => p.peTTM);
  const pbSeries = history.series.map((p) => p.pbMRQ);
  return {
    peRank: latest?.peTTM != null ? percentileRank(peSeries, latest.peTTM) : null,
    pbRank: latest?.pbMRQ != null ? percentileRank(pbSeries, latest.pbMRQ) : null,
    latest,
    points: peSeries.filter((v): v is number => v != null && Number.isFinite(v)).length,
    window: history.window,
    fetchedAt: history.fetchedAt,
  };
}

/**
 * 读一只票的估值历史。
 *
 * 文件不在（没跑过脚本 / data 不在 git 里）= **没有这份数据**，返回 null。
 * 不许返回一条空序列冒充「查过了、历史是空的」——那是两种完全不同的事实。
 */
export async function loadValuationHistory(
  code: string,
  dir = process.cwd(),
): Promise<ValuationHistory | null> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(posixJoin(dir, "data", "fundamentals", `pe-${code}.json`), "utf-8");
    const parsed = JSON.parse(raw) as ValuationHistory;
    if (!parsed || !Array.isArray(parsed.series) || parsed.series.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 分位的人话。页面显示用，口径和算法在一处定。 */
export function rankPhrase(rank: number | null): string {
  if (rank == null) return "算不出历史位置";
  const rounded = Math.round(rank);
  if (rounded >= 80) return `历史 ${rounded} 分位（比过去绝大多数时候都贵）`;
  if (rounded <= 20) return `历史 ${rounded} 分位（比过去绝大多数时候都便宜）`;
  return `历史 ${rounded} 分位`;
}
