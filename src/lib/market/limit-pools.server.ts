/**
 * 这个文件是干什么的：
 * 涨停/炸板/跌停三个池的**采集**逻辑，server-only（`*.server.ts` 后缀，客户端图终端）。
 *
 * 为什么要从 limit-up.functions.ts 抽出来：
 * 2026-11-11 体检发现「首页 SSR 关键路径串行 + 限速」——getSignals 内部 3 个东财请求
 * 每轮 sleep 1300ms，被放进首页 loader 的 Promise.all 后把 GET / 拖到 4.386620s。
 * 东财实测开并发立刻 403，所以不能改并发；正确做法是把采集挪到盘后心跳跑一次、
 * 落盘，页面只读快照（getMarketSnapshot）。本模块给「定时采集脚本」和「实时刷新
 * 的 serverFn」共用，避免两边口径漂移。
 *
 * 纪律：
 * - 限速唯一出处 fetch-policy.ts，不写裸 sleep。
 * - 空表是「东财没返回/非交易日」，不是「今天没涨停」，用 why 说清，不拿全 0 冒充。
 * - 盘中数据未定（涨停池收盘后才定），用 sealed 标出来。
 */

import { parsePool, summarize, type LimitUpRow, type SignalSummary } from "./limit-up.ts";
import { rateLimitOf } from "./fetch-policy.ts";
import { shanghaiDate } from "./session.ts";

const UA = "Mozilla/5.0";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
export const POOLS: { kind: "limitUp" | "broken" | "limitDown"; endpoint: string; sort: string }[] = [
  { kind: "limitUp", endpoint: "getTopicZTPool", sort: "fbt:asc" },
  { kind: "broken", endpoint: "getTopicZBPool", sort: "fbt:asc" },
  { kind: "limitDown", endpoint: "getTopicDTPool", sort: "fund:asc" },
];

async function fetchPool(endpoint: string, sort: string, date: string): Promise<unknown> {
  const url = new URL(`https://push2ex.eastmoney.com/${endpoint}`);
  url.search = new URLSearchParams({
    ut: UT,
    dpt: "wz.ztzt",
    Pageindex: "0",
    pagesize: "10000",
    sort,
    date,
  }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export type PoolSnapshot = {
  date: string;
  /** 15:00 之后算定；盘中拉的涨停池是半截 */
  sealed: boolean;
  limitUp: LimitUpRow[];
  broken: LimitUpRow[];
  limitDown: LimitUpRow[];
  summary: SignalSummary | null;
  bad: number;
  why: string | null;
  /** 采集时刻（毫秒时间戳），页面要标数据新鲜度 */
  capturedAt: number;
  source: "eastmoney-push2ex";
};

/** 现在是不是收盘后（用 session 的上海时区口径，不自己判）。 */
export function sealedNow(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  return hour >= 15;
}

/** 串行采集三池。约 4 秒，只许在后台心跳/用户主动刷新时调用，不许进 SSR loader。 */
export async function collectPools(dateInput?: string, now = new Date()): Promise<PoolSnapshot> {
  const date = (dateInput ?? shanghaiDate()).replace(/-/g, "");
  const gap = rateLimitOf("eastmoney").minGapMs;
  const rows: Record<string, LimitUpRow[]> = { limitUp: [], broken: [], limitDown: [] };
  let bad = 0;
  const why: string[] = [];
  for (const pool of POOLS) {
    const payload = await fetchPool(pool.endpoint, pool.sort, date);
    const parsed = parsePool(payload, pool.kind);
    rows[pool.kind] = parsed.rows;
    bad += parsed.bad;
    if (parsed.rows.length === 0) why.push(pool.endpoint);
    await new Promise((r) => setTimeout(r, gap));
  }
  const summary = summarize(rows.limitUp, rows.broken, rows.limitDown);
  return {
    date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    sealed: sealedNow(now),
    limitUp: rows.limitUp,
    broken: rows.broken,
    limitDown: rows.limitDown,
    summary,
    bad,
    why: summary == null ? `东财没返回 ${why.join("、")}（这天多半不是交易日）` : null,
    capturedAt: now.getTime(),
    source: "eastmoney-push2ex",
  };
}
