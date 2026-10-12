/**
 * 这个文件是干什么的：
 * D4 的治理/流动性风险数据：股东户数（筹码集中度变化）+ 限售解禁表（未来的抛压日历）。
 * 都是按个股查的东财 datacenter 端点，不做全市场快照。
 *
 * 你需要知道的：
 * - 股东户数 RPT_HOLDERNUM_DET：HOLDER_NUM 单位户，HOLDER_NUM_RATIO 是较上期的
 *   变化百分比（8.1 = 户数环比 +8.1%，筹码发散；负 = 集中）。季度披露，一年 4 个点上下。
 * - 解禁 RPT_LIFT_STAGE：FREE_DATE 才是解禁日（东财字段不叫 LIFT_DATE，踩过 9501 报错）；
 *   FREE_SHARES 单位万股，LIFT_MARKET_CAP 单位万元，FREE_RATIO 是占总股本的比例
 *   （0.102 = 10.2%，页面展示 ×100）。历史解禁也有——只展示未来 90 天内的。
 * - 解析是纯函数（单测钉单位）；fetch 带 1 小时内存缓存，server fn 直调。
 */

/** 一期股东户数。num 单位户，chgPct 是较上期变化百分比（负 = 筹码集中）。 */
export type HolderPoint = {
  date: string;
  num: number;
  chgPct: number | null;
};

/** 一次解禁。sharesYi 解禁股数（亿股），capYi 解禁市值（亿元），ratioPct 占总股本%。 */
export type LiftRow = {
  date: string;
  type: string;
  sharesYi: number;
  capYi: number;
  ratioPct: number;
};

type Raw = Record<string, unknown>;

/** 解析股东户数一期；缺户数返回 null。日期截到日。 */
export function parseHolder(raw: Raw): HolderPoint | null {
  const num = Number(raw.HOLDER_NUM);
  if (!Number.isFinite(num) || num <= 0) return null;
  const ratio = raw.HOLDER_NUM_RATIO == null ? null : Number(raw.HOLDER_NUM_RATIO);
  return {
    date: String(raw.END_DATE ?? "").slice(0, 10),
    num,
    chgPct: ratio != null && Number.isFinite(ratio) ? ratio : null,
  };
}

export function parseHolders(raws: Raw[]): HolderPoint[] {
  return raws
    .map(parseHolder)
    .filter((p): p is HolderPoint => p != null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 解析一条解禁记录；缺日期或股数返回 null。 */
export function parseLift(raw: Raw): LiftRow | null {
  const date = String(raw.FREE_DATE ?? "").slice(0, 10);
  const sharesWan = Number(raw.FREE_SHARES);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(sharesWan) || sharesWan <= 0) return null;
  const capWan = Number(raw.LIFT_MARKET_CAP);
  const ratio = Number(raw.FREE_RATIO);
  return {
    date,
    type: String(raw.FREE_SHARES_TYPE ?? "").trim() || "未标注类型",
    sharesYi: sharesWan / 10_000,
    capYi: Number.isFinite(capWan) && capWan > 0 ? capWan / 10_000 : 0,
    ratioPct: Number.isFinite(ratio) && ratio > 0 ? ratio * 100 : 0,
  };
}

/** 筛出 [today, today+withinDays] 内的解禁，按日期升序。 */
export function upcomingLifts(rows: LiftRow[], today: string, withinDays = 90): LiftRow[] {
  const end = new Date(today);
  end.setDate(end.getDate() + withinDays);
  const endStr = end.toISOString().slice(0, 10);
  return rows
    .filter((r) => r.date >= today && r.date <= endStr)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" };
const BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const TTL_MS = 60 * 60_000;
const holderCache = new Map<string, { at: number; points: HolderPoint[] }>();
const liftCache = new Map<string, { at: number; rows: LiftRow[] }>();

/** 最近 limit 期股东户数（最新在前）。缓存 1 小时。 */
export async function fetchHolders(code: string, limit = 8): Promise<HolderPoint[]> {
  const hit = holderCache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.points.slice(0, limit);
  const url =
    `${BASE}?reportName=RPT_HOLDERNUM_DET&columns=SECURITY_CODE,SECURITY_NAME_ABBR,END_DATE,HOLDER_NUM,HOLDER_NUM_RATIO` +
    `&pageSize=50&pageNumber=1&sortColumns=END_DATE&sortTypes=-1&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")`)}&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`股东户数 HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  const points = parseHolders(body.result?.data ?? []);
  holderCache.set(code, { at: Date.now(), points });
  return points.slice(0, limit);
}

/** 全部解禁记录（含历史），调用方用 upcomingLifts 筛。缓存 1 小时。 */
export async function fetchLifts(code: string): Promise<LiftRow[]> {
  const hit = liftCache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const url =
    `${BASE}?reportName=RPT_LIFT_STAGE&columns=SECURITY_CODE,SECURITY_NAME_ABBR,FREE_DATE,FREE_SHARES_TYPE,FREE_SHARES,LIFT_MARKET_CAP,FREE_RATIO` +
    `&pageSize=200&pageNumber=1&sortColumns=FREE_DATE&sortTypes=1&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")`)}&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`解禁表 HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  const rows = (body.result?.data ?? []).map(parseLift).filter((r): r is LiftRow => r != null);
  liftCache.set(code, { at: Date.now(), rows });
  return rows;
}
