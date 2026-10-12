/**
 * 这个文件是干什么的：
 * 从东财研报接口直连拉一只票的机构预测（D1），转成 consensus.ts 要的结构。
 *
 * 你需要知道的：
 * - 走东财 reportapi.eastmoney.com 公开接口，**不依赖 akshare**（akshare 的
 *   py-mini-racer 在本机 arm64 装不上，见 GAP-REPORT）。
 * - 接口返回的是**研报列表**（每份研报带该机构的三档预测 EPS 和评级），
 *   一致预期要由 consensus.ts:aggregateConsensus 聚合，这里只负责取和归一。
 * - 接口字段里的 EPS 是字符串（"71.3200000000"），要转 number，转不了留 null。
 */

import type { ConsensusReport } from "./consensus.ts";

const REPORT_API = "https://reportapi.eastmoney.com/report/list";

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function day(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/** 拉一只票的机构预测列表。失败或没有数据返回 null。 */
export async function fetchConsensusReports(code: string, beginYear = 2025): Promise<ConsensusReport[] | null> {
  const params = new URLSearchParams({
    industryCode: "*",
    pageSize: "50",
    industry: "*",
    rating: "*",
    ratingChange: "*",
    beginTime: `${beginYear}-01-01`,
    endTime: "2030-12-31",
    pageNo: "1",
    qType: "0",
    code,
    rcode: "",
    p: "1",
    pageNum: "1",
  });
  const url = `${REPORT_API}?${params.toString()}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown[] };
    if (!Array.isArray(body.data) || body.data.length === 0) return null;
    const reports: ConsensusReport[] = [];
    for (const item of body.data) {
      const r = item as Record<string, unknown>;
      reports.push({
        orgName: String(r.orgName ?? ""),
        publishDate: day(r.publishDate),
        rating: String(r.emRatingName ?? ""),
        thisYearEps: num(r.predictThisYearEps),
        nextYearEps: num(r.predictNextYearEps),
        nextTwoYearEps: num(r.predictNextTwoYearEps),
        thisYearPe: num(r.predictThisYearPe),
        nextYearPe: num(r.predictNextYearPe),
        nextTwoYearPe: num(r.predictNextTwoYearPe),
      });
    }
    return reports.length > 0 ? reports : null;
  } catch {
    return null;
  }
}
