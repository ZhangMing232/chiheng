/**
 * 这个文件是干什么的：
 * 融资融券（D3 的杠杆那一半）。东财 datacenter 个股两融明细抓下来落盘，
 * 风险清单从此有「这只票杠杆资金多重」的实数。
 *
 * 你需要知道的：
 * - 数据源：datacenter-web.eastmoney.com RPTA_WEB_RZRQ_GGMX，字段原文照抄
 *   （RZYE 融资余额、RZJME 融资净买额、RQYE 融券余额、RZYEZB 融资余额占流通市值%）。
 *   金额单位是元——页面展示一律在 view 层换算，这里保留原值，单测钉单位。
 * - 口径坑：RZYEZB 是「占流通市值比」，老记录可能为 null——缺的样子就是缺，
 *   不许拿 0 凑（factors-view 的同一条铁律）。
 * - 抓取走 scripts/fetch-margin.ts 落盘 data/risk/margin-latest.json；
 *   server 只读产物文件（UI-STANDARD 数据契约：前端不藏业务常量）。
 * - 龙虎榜当天账在 hotmoney.ts（已有）；它的「历史」由 scripts/record-hotmoney.ts
 *   每天收盘后append 一份到 data/risk/hotmoney/，复盘可回溯。
 */

/** 一只股票一天的两融账。金额单位元，ratio 是百分比（6.31 = 6.31%）。 */
export type MarginRow = {
  id: string;
  name: string;
  /** 融资余额（元） */
  rzye: number;
  /** 融资净买额（元），正是加杠杆买入，负是去杠杆 */
  rzjme: number;
  /** 融券余额（元） */
  rqye: number;
  /** 融资余额占流通市值比（%）；源数据缺 → null */
  ratio: number | null;
};

/** 一天的两融全市场账。rows 按融资余额降序。 */
export type MarginBook = {
  /** 交易日，没抓到是空字符串 */
  date: string;
  rows: MarginRow[];
};

type Raw = Record<string, unknown>;

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 解析一行原始数据；代码缺失或余额非正 → null（那行不算数，不编）。 */
export function parseMarginRow(raw: Raw): MarginRow | null {
  const code = String(raw.SCODE ?? "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  const rzye = num(raw.RZYE);
  if (rzye == null) return null;
  const ratio = raw.RZYEZB == null ? null : Number(raw.RZYEZB);
  return {
    id: code,
    name: String(raw.SECNAME ?? "").trim(),
    rzye,
    rzjme: Number(raw.RZJME ?? 0) || 0,
    rqye: Number(raw.RQYE ?? 0) || 0,
    ratio: ratio != null && Number.isFinite(ratio) && ratio > 0 ? ratio : null,
  };
}

/** 解析一页到一页的净结果（坏行扔掉并计数——缺口要见光，UI 用 missing 显式列）。 */
export function parseMarginPage(raws: Raw[]): { rows: MarginRow[]; missing: number } {
  const rows: MarginRow[] = [];
  let missing = 0;
  for (const raw of raws) {
    const row = parseMarginRow(raw);
    if (row) rows.push(row);
    else missing += 1;
  }
  rows.sort((a, b) => b.rzye - a.rzye);
  return { rows, missing };
}

/** 全市场汇总（纯函数）：总融资余额、总净买额、有占比数据的只数。金额返回亿元。 */
export function marginSummary(book: MarginBook): {
  totalRzyeYi: number;
  totalRzjmeYi: number;
  withRatio: number;
} {
  let rzye = 0;
  let rzjme = 0;
  let withRatio = 0;
  for (const row of book.rows) {
    rzye += row.rzye;
    rzjme += row.rzjme;
    if (row.ratio != null) withRatio += 1;
  }
  return { totalRzyeYi: rzye / 1e8, totalRzjmeYi: rzjme / 1e8, withRatio };
}

const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" };
const COLUMNS = "DATE,SCODE,SECNAME,RZYE,RZJME,RQYE,RZYEZB,SZ,SPJ,ZDF";
const BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";

/** 东财已发布的最新两融交易日。拿不到返回空串。 */
export async function latestMarginDate(): Promise<string> {
  const url =
    `${BASE}?reportName=RPTA_WEB_RZRQ_GGMX&columns=DATE&pageSize=1&pageNumber=1` +
    "&sortColumns=DATE&sortTypes=-1&source=WEB&client=WEB";
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return "";
  const body = (await res.json()) as { result?: { data?: { DATE?: string }[] } };
  return String(body.result?.data?.[0]?.DATE ?? "").slice(0, 10);
}

/** 抓某一天的全部个股两融（分页 500/页）。任何一页失败就抛——缺页的数据比没有更害人。 */
export async function fetchMarginBook(date: string): Promise<{ book: MarginBook; missing: number }> {
  const filter = encodeURIComponent(`(DATE='${date}')`);
  const first = await pullPage(filter, 1);
  const pages = Math.min(first.pages, 40);
  const all = [...first.data];
  for (let page = 2; page <= pages; page += 1) {
    const next = await pullPage(filter, page);
    all.push(...next.data);
  }
  const { rows, missing } = parseMarginPage(all);
  return { book: { date, rows }, missing };
}

async function pullPage(filter: string, page: number): Promise<{ pages: number; data: Raw[] }> {
  const url =
    `${BASE}?reportName=RPTA_WEB_RZRQ_GGMX&columns=${COLUMNS}&pageSize=500&pageNumber=${page}` +
    `&filter=${filter}&sortColumns=RZYE&sortTypes=-1&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`两融第 ${page} 页 HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { pages?: number; data?: Raw[] } };
  return { pages: body.result?.pages ?? 1, data: Array.isArray(body.result?.data) ? body.result.data : [] };
}
