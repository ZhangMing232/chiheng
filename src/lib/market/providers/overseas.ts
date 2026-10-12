/**
 * 这个文件是干什么的：
 * 港股/美股的行情 provider（M1/M2 数据层）。走东财港股(116)/美股(105)行情域，
 * 和 A 股的腾讯主源完全分开——美港不在全市场快照里，只支持按代码查。
 *
 * 你需要知道的：
 * - **为什么不用 Yahoo**：REMAINING.md 里写的是「数据源可用 yahoo（它用的）」，
 *   但 2026-10-12 实测本机访问 query1.finance.yahoo.com 返回运营商 block 页（HTML），
 *   东财港美接口全通（quote/kline/suggest 都 200）。所以实际接的是东财，
 *   registry 和本文档都如实标注，Yahoo 留作备用路线。
 * - secid 规则：港股 hk00700 → 116.00700，美股 usAAPL → 105.AAPL。
 * - K 线字符串是「日期,开,收,高,低,量,额」七段（注意开收在高低的**前面**，和腾讯
 *   的 qfqday 不一样），价格已是原值不用缩放（实测港股 decimal=3、美股 decimal=3，
 *   klines 里直接是 425.800 / 340.935 这种明文）。
 * - 报价用 kline lmt=1 顺带拿：一个请求同时拿到最新一根 K 线 + preKPrice（昨收）
 *   + name，不用碰 stock/get 的 f43 缩放（那个港股要 ÷1000、口径还随票变）。
 * - 搜索走 searchapi 联想接口（token 是东财网页自己在用的公开 token）。
 */

/** 一只港/美股此刻的行情。price 是该市场货币单位（港元/美元），chg 是百分数。 */
export type OverseasQuote = {
  id: string;
  code: string;
  name: string;
  price: number;
  /** 相对昨收涨跌幅，百分数。没有昨收时是 null。 */
  chg: number | null;
  prevClose: number | null;
  /** 行情日期 YYYY-MM-DD（该市场最近一个交易日）。 */
  asOf: string;
};

type Raw = Record<string, unknown>;

/** 内部 id → 东财 secid。认不出的前缀返回 null（A 股不该走到这里）。 */
export function secidOf(id: string): string | null {
  const hk = /^hk(\d{5})$/.exec(id);
  if (hk) return `116.${hk[1]}`;
  const us = /^us([A-Z][A-Z0-9.-]{0,5})$/.exec(id);
  if (us) return `105.${us[1]}`;
  return null;
}

/** 解析一根 K 线字符串「日期,开,收,高,低,量,额」。价格顺序开收在高前，别照搬腾讯。 */
export function parseKlineRow(line: string): { date: string; o: number; c: number; h: number; l: number; v: number } | null {
  const parts = line.split(",");
  if (parts.length < 6) return null;
  const [date, o, c, h, l, v] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return null;
  const nums = [o, c, h, l].map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const vol = Number(v);
  return { date, o: nums[0]!, c: nums[1]!, h: nums[2]!, l: nums[3]!, v: Number.isFinite(vol) ? vol : 0 };
}

export function parseKlines(raw: unknown): { date: string; o: number; c: number; h: number; l: number; v: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((line) => parseKlineRow(String(line))).filter((b): b is NonNullable<typeof b> => b != null);
}

/** 从 kline/get 的 data 节点解析行情。缺名称或最新价返回 null。 */
export function parseQuote(id: string, data: Raw | null | undefined): OverseasQuote | null {
  const rows = parseKlines(data?.klines);
  const last = rows[rows[rows.length - 1] ? rows.length - 1 : -1];
  const name = typeof data?.name === "string" ? data.name : "";
  const prev = Number(data?.preKPrice);
  if (!last || !name) return null;
  const chg = Number.isFinite(prev) && prev > 0 ? Math.round(((last.c - prev) / prev) * 10000) / 100 : null;
  return {
    id,
    code: id.replace(/^(hk|us)/, ""),
    name,
    price: last.c,
    chg,
    prevClose: Number.isFinite(prev) && prev > 0 ? prev : null,
    asOf: last.date,
  };
}

/** 联想接口的一条结果。 */
export type OverseasHit = { id: string; code: string; name: string; market: "hk" | "us" };

/** 解析联想结果，只留港股(116)/美股(105)正股，牛熊证/债券/权证都丢。 */
export function parseSuggest(raw: unknown): OverseasHit[] {
  const table = (raw as { QuotationCodeTable?: { Data?: unknown[] } })?.QuotationCodeTable;
  if (!Array.isArray(table?.Data)) return [];
  const out: OverseasHit[] = [];
  for (const item of table.Data) {
    const row = item as Raw;
    const mkt = String(row.MktNum ?? "");
    const type = String(row.SecurityType ?? "");
    const code = String(row.Code ?? "");
    const name = String(row.Name ?? "");
    // 正股才收：港股 SecurityType=19，美股 SecurityType=20（实测 AAPL 是 20，
    // Apple Notes 债券是 7）。其余（牛熊证/债券/涡轮）编号也是字母数字，混进来会搜出一堆衍生品。
    if (mkt === "116" && type === "19" && /^\d{5}$/.test(code)) out.push({ id: `hk${code}`, code, name, market: "hk" });
    else if (mkt === "105" && type === "20" && /^[A-Z][A-Z0-9.-]{0,5}$/.test(code)) out.push({ id: `us${code}`, code, name, market: "us" });
  }
  return out;
}

const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com/" };
/** 联想接口的 token 是东财网页自己在用的公开 token（quote.eastmoney.com 每个页面都带着）。 */
const SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const KLINE_FIELDS1 = "f1,f2,f3,f4,f5,f6";
const KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57";

async function fetchKlineData(id: string, limit: number): Promise<Raw | null> {
  const secid = secidOf(id);
  if (!secid) throw new Error(`不是港/美股代码：${id}`);
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0` +
    `&lmt=${limit}&end=20500101&iscca=1&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`港美行情 HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Raw | null };
  return body.data ?? null;
}

/** 拉一只港/美股最近 limit 根日 K（默认 250）。返回按日期升序。 */
export async function fetchOverseasKline(id: string, limit = 250) {
  const data = await fetchKlineData(id, limit);
  return parseKlines(data?.klines);
}

/** 拉一只港/美股此刻的报价（名称/现价/涨跌幅/昨收）。拉不到返回 null，调用方降级。 */
export async function fetchOverseasQuote(id: string): Promise<OverseasQuote | null> {
  const data = await fetchKlineData(id, 1);
  return parseQuote(id, data);
}

/** 按名称/拼音/代码搜港美股正股，最多 count 条。 */
export async function searchOverseas(query: string, count = 8): Promise<OverseasHit[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&count=${count}&token=${SUGGEST_TOKEN}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res?.ok) return [];
  return parseSuggest(await res.json());
}
