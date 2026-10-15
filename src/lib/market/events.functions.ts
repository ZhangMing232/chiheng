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
import { groupByCompany, parseForecast, type ForecastRow } from "./events.ts";

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
