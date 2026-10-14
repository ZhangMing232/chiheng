/**
 * 这个文件是干什么的：
 * 港股/美股**全市场行情列表**的解析与视图逻辑（2026-10-14 用户定的「只要行情能看数据」）。
 *
 * 探源结论（2026-10-14 实测，别凭印象改）：
 * - 港股 `fs=m:116` → **17429 只**（含 GEM、权证、仙股，什么都有）
 * - 美股 `fs=m:105,106,107` → **13854 只**（105/106/107 是三个交易所）
 * - 指数跨两个域：恒生/国企/道指/纳指/标普在 `100`，**恒生科技在 `124`**
 * - 搜索走东财 suggest（`searchapi.eastmoney.com/api/suggest/get`），港美都通
 *
 * 你需要知道的（纪律）：
 * 1. **这里只做行情，不接策略**。用户 2026-10-14 明确「不用策略，只要行情能看数据」。
 *    A 股那套（涨跌停/换手率闸/ST/板块/流通市值）在美股没有对应物，硬套是语义错误。
 *    所以这个模块**没有**任何选股、评分、买卖输出的函数，以后也别加。
 * 2. **不做全市场缓存**。A 股是一次拉 4606 只做全市场快照，港美加一起 3 万只——
 *    拉不完也没必要。改成按需分页（一次一页），页面翻页时再拉。
 * 3. **币种必须标**。港币和美元不是同一种钱，同一个「涨跌幅」列在两边含义不同。
 *    列表里每行都带币种，价格列不许混着看不加标签。
 * 4. 解析里 f2/f3/f4 在 `fltt=2` 时已经是小数（价格原值、涨跌幅百分数），
 *    **不要再乘 100 或除 100**——实测港股 1.75 / +12.9% 就是原值。
 */

/** 港股/美股市场。 */
export type OverseasMarket = "hk" | "us";

/** 列表里的一行。price/chg 的单位跟着 currency 走。 */
export type OverseasRow = {
  /** 内部 id：hk00700 / usNVDA */
  id: string;
  /** 展示用的代码（港股 5 位、美股 ticker） */
  code: string;
  name: string;
  price: number | null;
  /** 涨跌幅，百分数（12.9 = +12.9%）。没有报价时是 null，不是 0。 */
  chg: number | null;
  /** 涨跌额 */
  chgAmt: number | null;
  /** 成交额（元）。港股很多给 "-" → null */
  amount: number | null;
  market: OverseasMarket;
  currency: "HKD" | "USD";
  /** 东财的市场号，原样留着（美股 105/106/107 三个交易所） */
  secidMarket: number;
};

export const CURRENCY: Record<OverseasMarket, "HKD" | "USD"> = { hk: "HKD", us: "USD" };

/** 东财市场号 → 内部市场。116 是港股，105/106/107 是美股三个交易所。 */
export function marketOfSecid(secidMarket: number): OverseasMarket | null {
  if (secidMarket === 116) return "hk";
  if (secidMarket === 105 || secidMarket === 106 || secidMarket === 107) return "us";
  return null;
}

/** 代码 + 市场号 → 内部 id。认不出来返回 null（宁可少一行，不造一个假 id）。 */
export function rowId(code: string, secidMarket: number): string | null {
  const market = marketOfSecid(secidMarket);
  if (!market) return null;
  if (market === "hk") return /^\d{5}$/.test(code) ? `hk${code}` : null;
  return /^[A-Z][A-Z0-9.-]{0,5}$/.test(code) ? `us${code}` : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // 东财用 "-" 表示没有（港股成交额常见）
  if (typeof v === "string" && v !== "-" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 解析 clist 返回体。坏行跳过并记数，不让一行脏数据毁掉整页。
 * 价格为 0 或 null 的**照样列出来**（停牌/未开盘就是这样），但 chg 为 null 时
 * 页面要显示「—」而不是 0——0 会被读成「没涨跌」。
 */
export function parseOverseasList(payload: unknown): { rows: OverseasRow[]; bad: number; total: number } {
  const data = (payload as { data?: { total?: unknown; diff?: unknown } } | null)?.data;
  if (!data || typeof data !== "object") return { rows: [], bad: 0, total: 0 };
  const total = typeof data.total === "number" ? data.total : 0;
  const diff = data.diff;
  const rows: OverseasRow[] = [];
  let bad = 0;
  const list = Array.isArray(diff) ? diff : diff && typeof diff === "object" ? Object.values(diff) : [];
  for (const raw of list) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const code = typeof row.f12 === "string" ? row.f12 : "";
    const secidMarket = typeof row.f13 === "number" ? row.f13 : NaN;
    const name = typeof row.f14 === "string" ? row.f14.trim() : "";
    const id = rowId(code, secidMarket);
    const market = marketOfSecid(secidMarket);
    if (!id || !market || name === "") {
      bad += 1;
      continue;
    }
    rows.push({
      id,
      code,
      name,
      price: num(row.f2),
      chg: num(row.f3),
      chgAmt: num(row.f4),
      amount: num(row.f6),
      market,
      currency: CURRENCY[market],
      secidMarket,
    });
  }
  return { rows, bad, total };
}

export type OverseasSort = "chg" | "price" | "amount" | "code";

/** 东财 clist 的 fid：涨跌幅 f3 / 现价 f2 / 成交额 f6 / 代码 f12。 */
export const FID: Record<OverseasSort, string> = { chg: "f3", price: "f2", amount: "f6", code: "f12" };

/**
 * 本地排序。排序在服务端做（一次只拿一页），这里只用于「自选」那几行
 * 和客户端切换时的即时重排。
 * 缺值沉底：没成交额的排不到「成交额最高」那一头去冒充成交额高的票。
 */
export function sortOverseas(rows: readonly OverseasRow[], by: OverseasSort, desc = true): OverseasRow[] {
  const out = [...rows];
  const miss = (r: OverseasRow) => (by === "code" ? false : pick(r, by) == null);
  out.sort((a, b) => {
    const ma = miss(a);
    const mb = miss(b);
    if (ma !== mb) return ma ? 1 : -1;
    let d = 0;
    if (by === "code") d = a.code.localeCompare(b.code);
    else d = (pick(a, by) as number) - (pick(b, by) as number);
    return desc ? -d : d;
  });
  return out;
}

function pick(r: OverseasRow, by: OverseasSort): number | string | null {
  if (by === "price") return r.price;
  if (by === "amount") return r.amount;
  if (by === "code") return r.code;
  return r.chg;
}

/** 按代码或名称过滤当前页。空串 = 全要。 */
export function filterOverseas(rows: readonly OverseasRow[], q: string): OverseasRow[] {
  const key = q.trim().toLowerCase();
  if (!key) return [...rows];
  return rows.filter((r) => r.code.toLowerCase().includes(key) || r.name.toLowerCase().includes(key));
}

/**
 * 建议要搜整市场时走 suggest 接口而不是本地过滤——本页只有 100 只，
 * 本地搜只能搜到这一页，搜不到就变成「没有」了。页面据此提示。
 */
export const OVERSEAS_PAGE_SIZE = 100;
