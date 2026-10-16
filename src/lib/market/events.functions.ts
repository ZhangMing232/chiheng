/**
 * 这个文件是干什么的：
 * 事件驱动的服务端接口（/events 页）。先做业绩预告（预期差的核心原料）。
 *
 * 接口：东财数据中心 `RPT_PUBLIC_OP_NEWPREDICT`（零鉴权），限速走 fetch-policy
 * 的 eastmoney（1300ms 串行——和资金流、行业那些同一个源，一个风控面）。
 *
 * 你需要知道的：
 * - **全市场 0 行要报错**：那说明接口坏了或者被限流了，不是「今天没有预告」。
 *   带日期条件的 0 行才是「确实没有」。
 * - 业绩预告在盘前盘后都可能发（实测 2026-10-15 那条就是 00:00 发的），
 *   所以这一页刷新随时可能有新东西。
 */

import { createServerFn } from "@tanstack/react-start";
import {
  groupByCompany,
  parseBuybacks,
  parseForecast,
  parseHolderTrades,
  parseSurveys,
  type Buyback,
  type ForecastRow,
  type HolderTrade,
  type Survey,
} from "./events.ts";

const REPORT = "RPT_PUBLIC_OP_NEWPREDICT";
const COLUMNS = [
  "SECUCODE",
  "SECURITY_CODE",
  "SECURITY_NAME_ABBR",
  "NOTICE_DATE",
  "REPORT_DATE",
  "PREDICT_FINANCE",
  "PREDICT_TYPE",
  "FORECAST_JZ",
  "PREYEAR_SAME_PERIOD",
  "PREDICT_AMT_LOWER",
  "PREDICT_AMT_UPPER",
  "PREDICT_RATIO_LOWER",
  "PREDICT_RATIO_UPPER",
  "CHANGE_REASON_EXPLAIN",
  "IS_LATEST",
].join(",");

export type ForecastPayload = {
  rows: ForecastRow[];
  /** 按票聚合好的一只一条（页面上要按票显示，不是一股一行） */
  companies: ReturnType<typeof groupByCompany>;
  bad: number;
  why: string | null;
  /** 数据截至哪天（接口不给"今天"这个保证） */
  asOf: string | null;
};

export const getForecasts = createServerFn({ method: "GET" })
  .validator((input: unknown): { limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const n = typeof v.limit === "number" ? v.limit : 60;
    return { limit: Math.max(10, Math.min(300, Math.round(n))) };
  })
  .handler(async ({ data }): Promise<ForecastPayload> => {
    const empty: ForecastPayload = { rows: [], companies: [], bad: 0, why: null, asOf: null };
    try {
      const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
      url.search = new URLSearchParams({
        reportName: REPORT,
        columns: COLUMNS,
        // **必须降序**：东财分页从第 1 页起，升序拿到的是最早的那些（上次接 LPR 踩过）
        sortColumns: "NOTICE_DATE",
        sortTypes: "-1",
        pageSize: String(data.limit),
        pageNumber: "1",
      }).toString();
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return { ...empty, why: `东财 HTTP ${res.status}` };
      const body = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
      const raw = body.result?.data;
      if (!Array.isArray(raw)) return { ...empty, why: "东财没返回 data（接口结构变了或被限流）" };
      // **全市场 0 行 = 接口坏了**，不是「今天没预告」——别显示成空页
      if (raw.length === 0) return { ...empty, why: "东财返回 0 行：接口坏了或被限流，不是「今天没有预告」" };
      const parsed = parseForecast(raw);
      if (parsed.rows.length === 0) return { ...empty, why: `认出 0 行有效数据（${parsed.bad} 行坏行）` };
      return {
        rows: parsed.rows,
        companies: groupByCompany(parsed.rows),
        bad: parsed.bad,
        why: null,
        asOf: parsed.rows[0]?.noticeDate ?? null,
      };
    } catch (error) {
      return { ...empty, why: `没拉到：${error instanceof Error ? error.message : String(error)}` };
    }
  });

// ── 股东增减持 / 机构调研 / 股票回购 ───────────────────────────────────
//
// 三个都走东财 datacenter，公共抓取逻辑抽成 fetchEvent()。**三条纪律抄自
// a-stock-data SKILL §14 的 _em_event_rows**（它是被实测校准过的）：
// 1. 全市场、不带任何条件却 0 行 = 接口坏了，报错；带了个股/日期条件的 0 行
//    才是「确实没有」
// 2. **排序字段必须能唯一确定一行**：东财按页切片，排序有并列时翻页会重复一行
//    同时漏掉另一行（skill 实测质押表 2212 行重复 1 漏 1）——发现完全重复的行
//    直接报错，不把不完整的结果当完整的返回
// 3. **服务端筛选要逐行核对**：接口忽略 filter 或回了缓存页时能发现，
//    不把别的标的/日期的数据当结果

const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";

type EventFetch = {
  report: string;
  /** (FIELD="value") 形式的 filter，拼起来 */
  filter?: string;
  /** 排序字段（必须能唯一确定一行） */
  sortColumns: string;
  sortTypes: string;
  limit: number;
  /** 逐行核对的字段=值（filter 被接口忽略时能发现） */
  equal?: Record<string, string>;
};

async function fetchEvent(cfg: EventFetch): Promise<{ rows: Record<string, unknown>[]; why: string | null }> {
  const url = new URL(DATACENTER);
  url.search = new URLSearchParams({
    reportName: cfg.report,
    columns: "ALL",
    filter: cfg.filter ?? "",
    // **必须降序**：东财分页从第 1 页起，升序拿到的是最早的（接 LPR/预告时踩过）
    sortColumns: cfg.sortColumns,
    sortTypes: cfg.sortTypes,
    pageSize: String(Math.min(cfg.limit, 500)),
    pageNumber: "1",
  }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { rows: [], why: `东财 HTTP ${res.status}` };
  const body = (await res.json()) as { code?: number; message?: string; result?: { data?: Record<string, unknown>[] } };
  const rows = body.result?.data;
  if (!Array.isArray(rows)) return { rows: [], why: `东财没返回 data（code=${body.code} ${body.message ?? ""}）` };
  // 纪律 1：全市场 0 行 = 接口坏了，不是「今天没有」
  if (rows.length === 0 && !cfg.filter) {
    return { rows: [], why: `东财 ${cfg.report} 全市场返回 0 行：接口坏了或被限流，不是「今天没有」` };
  }
  // 纪律 2：完全重复的行 = 排序不唯一、翻页漏数据，结果不完整
  const seen = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) {
      return { rows: [], why: `东财 ${cfg.report} 返回了完全重复的行：排序字段不能唯一确定一行，翻页会漏数据，结果不完整` };
    }
    seen.add(key);
  }
  // 纪律 3：filter 被忽略/回缓存页能发现
  for (const [field, value] of Object.entries(cfg.equal ?? {})) {
    const wrong = rows.find((row) => String(row[field] ?? "") !== value);
    if (wrong) {
      return { rows: [], why: `东财 ${cfg.report} 请求 ${field}="${value}"，却返回了 ${String(wrong[field] ?? "")}：接口忽略了筛选或回了缓存页，结果不可信` };
    }
  }
  return { rows, why: null };
}

/** 股东增减持（重要股东二级市场/大宗交易等变动公告）。 */
export const getHolderTrades = createServerFn({ method: "GET" })
  .validator((input: unknown): { limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const n = typeof v.limit === "number" ? v.limit : 60;
    return { limit: Math.max(10, Math.min(300, Math.round(n))) };
  })
  .handler(async ({ data }): Promise<{
    rows: HolderTrade[];
    bad: number;
    why: string | null;
  }> => {
    const empty = { rows: [], bad: 0, why: null as string | null };
    try {
      // 排序五字段（公告日/代码/股东/变动起止）——skill 实测这套能唯一确定一行
      const { rows: raw, why } = await fetchEvent({
        report: "RPT_SHARE_HOLDER_INCREASE",
        sortColumns: "NOTICE_DATE,SECURITY_CODE,HOLDER_NAME,START_DATE,END_DATE",
        sortTypes: "-1,1,1,1,1",
        limit: data.limit,
      });
      if (why) return { ...empty, why };
      const parsed = parseHolderTrades(raw);
      if (parsed.rows.length === 0) return { ...empty, why: `认出 0 行有效数据（${parsed.bad} 行坏行）` };
      return { rows: parsed.rows, bad: parsed.bad, why: null };
    } catch (error) {
      return { ...empty, why: `没拉到：${error instanceof Error ? error.message : String(error)}` };
    }
  });

/** 机构调研（汇总模式：一次调研一行，SUM 是参与机构家数）。 */
export const getSurveys = createServerFn({ method: "GET" })
  .validator((input: unknown): { limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const n = typeof v.limit === "number" ? v.limit : 60;
    return { limit: Math.max(10, Math.min(300, Math.round(n))) };
  })
  .handler(async ({ data }): Promise<{
    rows: Survey[];
    bad: number;
    why: string | null;
  }> => {
    const empty = { rows: [], bad: 0, why: null as string | null };
    try {
      const { rows: raw, why } = await fetchEvent({
        report: "RPT_ORG_SURVEYNEW",
        // 汇总模式的 filter（skill 原文）；IS_SOURCE=来源公告、NUMBERNEW=汇总行
        filter: '(IS_SOURCE="1")(NUMBERNEW="1")',
        sortColumns: "NOTICE_DATE,SECURITY_CODE,RECEIVE_START_DATE",
        sortTypes: "-1,1,-1",
        limit: data.limit,
        equal: { IS_SOURCE: "1", NUMBERNEW: "1" },
      });
      if (why) return { ...empty, why };
      const parsed = parseSurveys(raw);
      if (parsed.rows.length === 0) return { ...empty, why: `认出 0 行有效数据（${parsed.bad} 行坏行）` };
      return { rows: parsed.rows, bad: parsed.bad, why: null };
    } catch (error) {
      return { ...empty, why: `没拉到：${error instanceof Error ? error.message : String(error)}` };
    }
  });

/** 股票回购（一个方案一行，按最新公告日倒序）。 */
export const getBuybacks = createServerFn({ method: "GET" })
  .validator((input: unknown): { limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const n = typeof v.limit === "number" ? v.limit : 60;
    return { limit: Math.max(10, Math.min(300, Math.round(n))) };
  })
  .handler(async ({ data }): Promise<{
    rows: Buyback[];
    bad: number;
    why: string | null;
  }> => {
    const empty = { rows: [], bad: 0, why: null as string | null };
    try {
      // 排序三字段（更新日/代码/方案号）——REPURCODE 是方案唯一号，带上它才唯一
      const { rows: raw, why } = await fetchEvent({
        report: "RPTA_WEB_GETHGLIST_NEW",
        sortColumns: "UPD,DIM_SCODE,REPURCODE",
        sortTypes: "-1,1,1",
        limit: data.limit,
      });
      if (why) return { ...empty, why };
      const parsed = parseBuybacks(raw);
      if (parsed.rows.length === 0) return { ...empty, why: `认出 0 行有效数据（${parsed.bad} 行坏行）` };
      return { rows: parsed.rows, bad: parsed.bad, why: null };
    } catch (error) {
      return { ...empty, why: `没拉到：${error instanceof Error ? error.message : String(error)}` };
    }
  });
