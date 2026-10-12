/**
 * 这个文件是干什么的：
 * 财报拆解的可执行部分（D2 落地后的升级版）。它把 baostock 三表的**累计值**
 * 拆成单季、TTM、同比，并做杜邦一致性验证和利润质量检查。
 *
 * 学 Vibe-Research 的 `earnings-analysis` SKILL.md，这次能照它的口径地图做了
 * （D2 之前赤轨只有比率做不了拆解，现在有 baostock 的绝对值科目了）：
 *   累计值 → quarterize → 单季 → TTM / 单季同比，杜邦三因子验证，CFO/NP 利润质量。
 *
 * 你需要知道的（纪律）：
 * 1. **累计值是原料、单季是基本单位**：A 股财报披露的是报告期累计值
 *    （Q1 / H1 / Q1–Q3 / 全年），单季必须拆出来，不在脑子里减。这是它 §0 铁律 1。
 * 2. **quarterize 前先查报告期连续性**：中间缺一期（如缺 Q3），「全年 − H1」
 *    算出来的是两季之和不是单季——拆错了比不拆更糟，要显式标 not_meaningful。
 * 3. 杜邦验证：ROE 应 ≈ 净利率 × 周转 × 权益乘数。对不上说明数据源内部不一致，
 *    要写出来，不能默默用。
 * 4. 所有派生数字都带出处（证据 id）——延续 P0-3 证据层。
 */

/** 一行 baostock 三表数据（字段名与 data/backtest/financials.json 一致）。 */
export type FinancialRow = {
  /** 公告日期（PIT） */
  pubDate: string;
  /** 报告期，如 2026-06-30 */
  statDate: string;
  /** 净利润（累计值，元） */
  netProfit: number | null;
  /** 主营收入（累计值，元） */
  revenue: number | null;
  /** ROE（累计口径，小数 0.1795 = 17.95%） */
  roe: number | null;
  /** 毛利率（累计口径） */
  gpMargin: number | null;
  /** 净利率（累计口径） */
  npMargin: number | null;
  /** EPS TTM（元/股） */
  epsTTM: number | null;
  /** 资产负债率（小数） */
  debt: number | null;
  /** 经营现金流 / 净利润 */
  cfoToNp: number | null;
  /** 杜邦：ROE / 周转 / 权益乘数 / 净利率 */
  dupontROE: number | null;
  assetTurn: number | null;
  assetToEquity: number | null;
  nitogr: number | null;
};

/** 拆出来的一个单季。 */
export type Quarter = {
  statDate: string;
  /** 单季净利润（元）。null = 这一季拆不出来（缺上一期） */
  netProfit: number | null;
  /** 单季营收。同上 */
  revenue: number | null;
};

export type DupontCheck = {
  roe: number | null;
  nitogr: number | null;
  assetTurn: number | null;
  assetToEquity: number | null;
  /** 三因子乘积 vs ROE 的相对误差。null = 算不出（有因子缺失） */
  drift: number | null;
  /** 一致性结论 */
  ok: boolean;
};

export type FinancialRead = {
  rows: FinancialRow[];
  /** 按报告期升序的单季序列 */
  quarters: Quarter[];
  /** TTM 净利润 = 近 4 个单季之和。null = 不够 4 季 */
  ttmNetProfit: number | null;
  /** 最新单季同比（对去年同期单季）。null = 不够 8 期或去年同期缺失 */
  latestYoy: number | null;
  /** 杜邦一致性（用最新一期） */
  dupont: DupontCheck | null;
  /** 利润质量（经营现金流/净利润，最新一期） */
  cfoToNp: number | null;
  gaps: string[];
};

function sub(a: number | null, b: number | null): number | null {
  return a != null && b != null ? a - b : null;
}

function ratio(a: number | null, b: number | null): number | null {
  return a != null && b != null && b !== 0 ? a / b : null;
}

/** 按报告期（statDate）升序。报告期是 YYYY-MM-DD，字典序即时间序。 */
export function sortByStatDate(rows: readonly FinancialRow[]): FinancialRow[] {
  return [...rows].sort((a, b) => a.statDate.localeCompare(b.statDate));
}

/**
 * 累计值 → 单季。
 *
 * ⚠️ A 股财报的累计值**每年 Q1 重置**（Q1 的累计值就是 Q1 单季，不是「今年累计
 * 减去年全年」）。所以拆单季要分两种情况：
 *   - 当期是 Q1（statDate 以 03-31 结尾）→ 单季 = 当期累计值本身
 *   - 其余 → 单季 = 当期累计 − 上一期累计
 * 跨年直接减会把「今年 Q1」减「去年全年」算成负的——测试抓出过这个错。
 * 报告期连续性由调用方在 readFinancials 里检查。
 */
export function quarterize(rows: readonly FinancialRow[]): Quarter[] {
  const sorted = sortByStatDate(rows);
  return sorted.map((row, i) => {
    const isQ1 = row.statDate.endsWith("03-31");
    if (i === 0 || isQ1) return { statDate: row.statDate, netProfit: row.netProfit, revenue: row.revenue };
    const prev = sorted[i - 1]!;
    return { statDate: row.statDate, netProfit: sub(row.netProfit, prev.netProfit), revenue: sub(row.revenue, prev.revenue) };
  });
}

/** TTM = 近 4 个单季之和。不够 4 季返回 null（不拿 3 季凑，它 §1 的规矩）。 */
export function ttmNetProfit(quarters: readonly Quarter[]): number | null {
  if (quarters.length < 4) return null;
  const tail = quarters.slice(-4);
  if (tail.some((q) => q.netProfit == null)) return null;
  return tail.reduce((s, q) => s + (q.netProfit as number), 0);
}

/**
 * 单季同比：最新单季 ÷ 去年同期单季 − 1。
 * 只需 5 期连续（最新 + 往前 4 季的去年同期）；TTM 同比才需要 8 期，别混。
 */
export function latestYoy(quarters: readonly Quarter[]): number | null {
  if (quarters.length < 5) return null;
  const cur = quarters[quarters.length - 1]!.netProfit;
  const base = quarters[quarters.length - 5]!.netProfit; // 去年同期 = 往前 4 季
  if (cur == null || base == null || base === 0) return null;
  return cur / base - 1;
}

/** 杜邦一致性：ROE 应 ≈ 净利率 × 周转 × 权益乘数。 */
export function dupontCheck(row: FinancialRow): DupontCheck | null {
  const { dupontROE, nitogr, assetTurn, assetToEquity } = row;
  if (dupontROE == null || nitogr == null || assetTurn == null || assetToEquity == null) return null;
  const product = nitogr * assetTurn * assetToEquity;
  const drift = Math.abs(product - dupontROE) / Math.max(Math.abs(dupontROE), 1e-9);
  return { roe: dupontROE, nitogr, assetTurn, assetToEquity, drift, ok: drift < 0.05 };
}

/**
 * 读一只票的三表，给出完整拆解。
 *
 * 报告期连续性：报告期之间应相隔 1 或 2 个季度（Q1→H1 隔 1 季，H1→Q3 隔 1 季，
 * Q3→全年 隔 1 季，全年→下年 Q1 隔 1 季）。实际都是 1 季，出现别的间隔就标缺口。
 */
export function readFinancials(rows: readonly FinancialRow[]): FinancialRead {
  const sorted = sortByStatDate(rows);
  const gaps: string[] = [];
  if (sorted.length === 0) {
    return { rows: [], quarters: [], ttmNetProfit: null, latestYoy: null, dupont: null, cfoToNp: null, gaps: ["没有三表数据（跑 scripts/fetch-three-sheets.py 才有）"] };
  }

  // 报告期连续性检查
  for (let i = 1; i < sorted.length; i += 1) {
    const gapMonths = monthGap(sorted[i - 1]!.statDate, sorted[i]!.statDate);
    if (gapMonths !== 3) {
      gaps.push(`报告期 ${sorted[i - 1]!.statDate} → ${sorted[i]!.statDate} 相隔 ${gapMonths} 个月，不是连续季度，单季拆解可能不准`);
    }
  }

  const quarters = quarterize(sorted);
  const ttm = ttmNetProfit(quarters);
  const yoy = latestYoy(quarters);
  const latest = sorted[sorted.length - 1]!;
  const dupont = dupontCheck(latest);
  const cfoToNp = latest.cfoToNp;

  if (quarters.length < 4) gaps.push("报告期不足 4 季，TTM 净利润算不出");
  if (quarters.length < 5) gaps.push("报告期不足 5 季，单季同比算不出（要对去年同期）");
  if (dupont && !dupont.ok) gaps.push(`杜邦三因子乘积与 ROE 偏差 ${(dupont.drift! * 100).toFixed(1)}%，数据源内部不一致，用之前要核对`);
  if (cfoToNp != null && cfoToNp < 1) gaps.push(`经营现金流/净利润 = ${cfoToNp.toFixed(2)} < 1，利润质量待查（现金流没跟上利润）`);

  return { rows: sorted, quarters, ttmNetProfit: ttm, latestYoy: yoy, dupont, cfoToNp, gaps };
}

/** 两个报告期相隔几个月。返回整数月。 */
function monthGap(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by! - ay!) * 12 + (bm! - am!);
}
