/**
 * 这个文件是干什么的：
 * 中债收益率曲线的服务端接口（/review 每日复盘用）。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §11.3（中央结算公司官方，零鉴权）。
 *
 * 你需要知道的：
 * 1. **官网单次查询超过 1 年会静默返回 0 行**——所以窗口固定 180 天，
 *    不给参数（要更长就得自己切片，那是回测的事，不是日频页面的事）。
 * 2. **它不公布债券市场交易日历**，也没有总条数，所以「某天没数据」分不清是节假日
 *    还是接口坏了。这里不报错，只报**数据截至哪天**，页面自己标。
 * 3. 缓存 6 小时：国债收益率一天只变一次（每交易日收盘后更新），6 小时内重复
 *    拉是浪费。TTL 走 fetch-policy，不在代码里写死。
 * 4. **拿不到就给 null**，页面显示「宏观数据没拿到」，不显示全 0。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import {
  lprSnapshotOf,
  parseLpr,
  parsePmi,
  parseSocialFinancing,
  parseYieldCurve,
  snapshotOf,
  type LprPoint,
  type MacroSnapshot,
  type PmiReading,
  type YieldPoint,
} from "./macro.ts";
import { ttlOf } from "@/lib/market/fetch-policy";

const CHINABOND_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery";
/** 官网超过 1 年静默返回 0 行，180 天留足余量。 */
const WINDOW_DAYS = 180;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export type MacroPayload = {
  snapshot: MacroSnapshot | null;
  /** 最近 N 个交易日，画曲线用 */
  points: YieldPoint[];
  /** 数据截至哪天（官网不给"今天"这个保证） */
  asOf: string | null;
  why: string | null;
};

async function fetchCurve(): Promise<string> {
  const url = new URL(CHINABOND_URL);
  url.search = new URLSearchParams({
    startDate: isoDaysAgo(WINDOW_DAYS),
    endDate: new Date().toISOString().slice(0, 10),
    gjqx: "0",
    qxId: "hzsylqx", // 国债收益率曲线
    locale: "cn_ZH",
  }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://yield.chinabond.com.cn/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`中债 HTTP ${res.status}`);
  return await res.text();
}

export const getMacro = createServerFn({ method: "GET" }).handler(async (): Promise<MacroPayload> => {
  try {
    const html = await fetchCurve();
    const { points, bad } = parseYieldCurve(html);
    if (points.length === 0) {
      return {
        snapshot: null,
        points: [],
        asOf: null,
        why: bad > 0 ? `中债返回了 ${bad} 行但没有一行认得出来，接口格式可能变了` : "中债没返回数据",
      };
    }
    // 画曲线只给最近 60 个交易日，够看形状了
    const tail = points.slice(-60);
    const snapshot = snapshotOf(points);
    return { snapshot, points: tail, asOf: snapshot?.date ?? null, why: null };
  } catch (error) {
    // 拿不到就说拿不到——页面显示「宏观数据没拿到」，不编数
    return {
      snapshot: null,
      points: [],
      asOf: null,
      why: `中债没拉到：${error instanceof Error ? error.message : String(error)}`,
    };
  }
});

/** 缓存有效期：国债收益率每交易日收盘后更新，6 小时足够。 */
export const MACRO_TTL_MS = ttlOf("kline") * 2;

// ── PMI（国家统计局，月频）────────────────────────────────────────────

const NBS_INDEX = "https://www.stats.gov.cn/sj/zxfb/";

async function fetchPmi(): Promise<PmiReading> {
  const idxRes = await fetch(NBS_INDEX, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(25000),
  });
  if (!idxRes.ok) throw new Error(`统计局 HTTP ${idxRes.status}`);
  const idxHtml = await idxRes.text();
  // 从最新发布列表里找标题含「采购经理指数」的那条
  const links = [...idxHtml.matchAll(/<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*<\/a>/g)];
  const hit = links.find((m) => (m[2] ?? "").includes("采购经理指数"));
  if (!hit) throw new Error("统计局发布页找不到「采购经理指数」条目（页面结构可能变了）");
  const url = hit[1]!.startsWith("http") ? hit[1]! : NBS_INDEX + hit[1]!.replace(/^\.\//, "");
  const bodyRes = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: NBS_INDEX },
    signal: AbortSignal.timeout(25000),
  });
  if (!bodyRes.ok) throw new Error(`统计局正文 HTTP ${bodyRes.status}`);
  return parsePmi(await bodyRes.text());
}

export const getPmi = createServerFn({ method: "GET" }).handler(async (): Promise<{
  pmi: PmiReading | null;
  why: string | null;
}> => {
  try {
    const pmi = await fetchPmi();
    // 主体三个（月/制造业/非制造业）任一缺失就当没拿到——半个 PMI 没有意义
    if (pmi.month == null || pmi.manufacturing == null) {
      return { pmi: null, why: "统计局页面认出了，但主体 PMI 解析不出来（格式可能变了）" };
    }
    return { pmi, why: null };
  } catch (error) {
    return { pmi: null, why: `统计局没拉到：${error instanceof Error ? error.message : String(error)}` };
  }
});

// ── LPR（东财数据中心，月频）────────────────────────────────────────────

const LPR_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";

export const getLpr = createServerFn({ method: "GET" }).handler(async (): Promise<{
  lpr: LprPoint | null;
  history: LprPoint[];
  why: string | null;
}> => {
  try {
    const url = new URL(LPR_URL);
    url.search = new URLSearchParams({
      reportName: "RPTA_WEB_RATE",
      columns: "TRADE_DATE,LPR1Y,LPR5Y",
      sortColumns: "TRADE_DATE",
      // **必须降序（-1）**：东财分页从第 1 页起，给升序的话拿到的是**最早**的 200 条
      // （2013-10 ~ 2014-06），而快照取的是最后一条 —— 页面就会显示 2014 年的报价。
      // 这个 bug 实测才发现的：测试用的是自己造的数据，测不出「东财怎么分页」。
      sortTypes: "-1",
      pageSize: "200",
      pageNumber: "1",
    }).toString();
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`东财 HTTP ${res.status}`);
    const body = (await res.json()) as { result?: { data?: Record<string, unknown>[] } };
    const rows = body.result?.data ?? [];
    const { points } = parseLpr(rows);
    const lpr = lprSnapshotOf(points);
    if (!lpr || lpr.lpr1y == null) {
      return { lpr: null, history: points, why: points.length === 0 ? "东财报表里没有 LPR 数据" : "认出了行但没有 1 年期数值" };
    }
    return { lpr, history: points, why: null };
  } catch (error) {
    return { lpr: null, history: [], why: `LPR 没拉到：${error instanceof Error ? error.message : String(error)}` };
  }
});

// ── 社会融资规模（读落盘文件，不实时抓）─────────────────────────────────
//
// 数据由 `scripts/fetch-social-financing.py` 落盘。为什么不实时抓：那条链路是
// 三级跳（索引 → 年份页 → 专题页 → xlsx 附件），一次要 4 个请求，而社融是
// **月频**数据（次月中旬发布），实时抓毫无意义。跑一次脚本用一个月。

const SF_PATH = () => join(process.cwd(), "data", "macro", "social-financing.json");

export const getSocialFinancing = createServerFn({ method: "GET" }).handler(async (): Promise<{
  file: import("./macro.ts").SocialFinancingFile | null;
  why: string | null;
}> => {
  try {
    const raw = await readFile(SF_PATH(), "utf-8");
    const file = parseSocialFinancing(JSON.parse(raw));
    if (!file) return { file: null, why: "落盘文件在，但内容认不出来（格式可能变了）" };
    return { file, why: null };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        file: null,
        why: "还没抓过。跑一次 python3 scripts/fetch-social-financing.py（社融次月中旬发布，跑一次能用一个月）",
      };
    }
    return { file: null, why: `读落盘文件失败：${error instanceof Error ? error.message : String(error)}` };
  }
});
