/**
 * 这个文件是干什么的：
 * 涨停/炸板/跌停三个池的服务端接口（/signals 信号页）。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §8.1（东财 push2ex 四池），
 * 赤轨只接东财这三个池，不接同花顺涨停揭秘——那个的"涨停原因题材"是市场叙事
 * 不是核验过的因果，接了要在页面上标清性质，这一步先不做。
 *
 * 你需要知道的：
 * 1. **东财限速走 fetch-policy**（1300ms 串行）。三个池 = 三个请求，
 *    串行拉完约 4 秒，可接受。别为省时间开并发——东财会封 IP。
 * 2. `date` 必须传交易日，非交易日东财 `data` 返回 null → 解析层给空表，
 *    页面显示"这天不是交易日"，**不显示全 0**（0 会被读成"今天没涨停"）。
 * 3. 当天盘中拉到的可能是**不完整**的（涨停池在收盘后才定）。页面要标
 *    "盘中数据未定"，别让人拿半截数据当结论。
 */

import { createServerFn } from "@tanstack/react-start";
import { parsePool, summarize, type LimitUpRow, type SignalSummary } from "./limit-up.ts";
import { rateLimitOf } from "./fetch-policy.ts";
import { shanghaiDate } from "./session.ts";

const UA = "Mozilla/5.0";
const UT = "7eea3edcaed734bea9cbfc24409ed989";
const POOLS: { kind: "limitUp" | "broken" | "limitDown"; endpoint: string; sort: string }[] = [
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

export type SignalPayload = {
  date: string;
  /** 今天是否已收盘（收盘后数据才定） */
  sealed: boolean;
  limitUp: LimitUpRow[];
  broken: LimitUpRow[];
  limitDown: LimitUpRow[];
  summary: SignalSummary | null;
  bad: number;
  why: string | null;
};

export const getSignals = createServerFn({ method: "GET" })
  .validator((input: unknown): { date?: string } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const date = typeof v.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : undefined;
    return { date };
  })
  .handler(async ({ data }): Promise<SignalPayload> => {
    const date = (data.date ?? shanghaiDate()).replace(/-/g, "");
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
    // 收盘判定：15:00 之后算定（用 session.ts 的口径，不自己再判一次）
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    return {
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      sealed: hour >= 15,
      limitUp: rows.limitUp,
      broken: rows.broken,
      limitDown: rows.limitDown,
      summary,
      bad,
      why: summary == null ? `东财没返回 ${why.join("、")}（这天多半不是交易日）` : null,
    };
  });
