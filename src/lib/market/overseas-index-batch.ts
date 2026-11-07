/**
 * 这个文件是干什么的：
 * 港美指数批量报价的解析。纯函数，不碰网络、不碰框架，方便测试把口径钉住。
 *
 * 为什么改成批量（2026-11-07）：
 * - 原来逐个打 `stock/get`，6 次请求、每两次之间 sleep 1300ms（东财限速），
 *   光等待就 7.8 秒，实测整组 9.17 秒；首页 SSR loader 直接被它拖到 9~24 秒才出首字节。
 * - 换成一次 `ulist.np/get` 传 6 个 secid，实测 49ms 一次回全。限速改成模块级节流
 *   （见 overseas-list.functions.ts），只节流「两次批量之间」，不在循环里白等。
 *
 * 口径纪律（不许松）：
 * - **涨跌幅仍是「现价和昨收自己算」**，不用东财算好的 f3（f3 只有 2 位小数）。
 *   旧接口 f43/f60 是放大 100 倍的整数，新接口 f2/f18 是还原后的点位，比例一致。
 *   2026-11-07 实测 6 个指数：f43/100 === f2、f60/100 === f18，自算涨跌与 f3 逐一对上。
 * - 批量接口对指数域**不返回** f43/f60（实测给 "-"），必须用 f2/f18。
 * - 恒生科技在 124 域，其余在 100 域：凭直觉写成 100.HSTECH 会拿不到。
 * - 休市时 f2 给 0 或 "-"：这是「这会儿没有新价格、只有昨收」，不是「没这只指数」。
 *   按项目铁律「拿不到 ≠ 没有」写进 gaps，绝不把 0 或空结果冒充行情。
 */

export type OverseasIndexQuote = {
  id: string;
  name: string;
  price: number | null;
  chg: number | null;
  secid: string;
};

/** 首页「全球市场」+ /overseas 指数页共用的 6 个指数。secid 里的域号别改。 */
export const OVERSEAS_INDICES: { id: string; secid: string }[] = [
  { id: "hsi", secid: "100.HSI" },
  { id: "hscei", secid: "100.HSCEI" },
  { id: "hstech", secid: "124.HSTECH" },
  { id: "djia", secid: "100.DJIA" },
  { id: "ndx", secid: "100.NDX" },
  { id: "spx", secid: "100.SPX" },
];

type BatchRow = Record<string, unknown>;

function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 东财 ulist 的 diff 有时是数组、有时是按序号索引的对象，两种都认。 */
function rowsOf(body: unknown): BatchRow[] {
  const data = (body as { data?: { diff?: unknown } } | null)?.data;
  const diff = data?.diff;
  const raw = Array.isArray(diff)
    ? diff
    : diff && typeof diff === "object"
      ? Object.values(diff as Record<string, unknown>)
      : [];
  return raw.filter((r): r is BatchRow => r != null && typeof r === "object");
}

/**
 * 把一次批量响应还原成 6 个指数的报价 + 缺口说明。
 * body 为 null（请求失败/超时）时 6 个都如实写「没拉到」，不编 0、不返回空数组了事。
 */
export function parseOverseasIndexBatch(body: unknown): { quotes: OverseasIndexQuote[]; gaps: string[] } {
  const bySecid = new Map<string, BatchRow>();
  for (const row of rowsOf(body)) {
    const code = typeof row.f12 === "string" ? row.f12 : null;
    const market = numOf(row.f13);
    if (code != null && market != null) bySecid.set(`${market}.${code}`, row);
  }

  const quotes: OverseasIndexQuote[] = [];
  const gaps: string[] = [];
  for (const item of OVERSEAS_INDICES) {
    const row = bySecid.get(item.secid);
    const name = typeof row?.f14 === "string" && row.f14 ? row.f14 : item.id;
    const price = numOf(row?.f2);
    const prev = numOf(row?.f18);

    if (price == null || price <= 0) {
      gaps.push(
        prev != null && prev > 0
          ? `${name} 这会儿没有新价格（只有昨收 ${prev.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}，多半是休市）`
          : `${name}（${item.secid}）没拉到`,
      );
      quotes.push({ id: item.id, name, price: prev != null && prev > 0 ? prev : null, chg: null, secid: item.secid });
      continue;
    }

    const chg = prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
    quotes.push({ id: item.id, name, price, chg, secid: item.secid });
  }
  return { quotes, gaps };
}
