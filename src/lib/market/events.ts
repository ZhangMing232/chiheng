/**
 * 这个文件是干什么的：
 * 事件驱动数据的解析（D10，对标 a-stock-data SKILL §14 的事件层）。
 * 先做业绩预告——它是预期差的核心原料，也是「催化剂 SOP 兑现验证」能用的那一份。
 *
 * 接口来自东财数据中心 `RPT_PUBLIC_OP_NEWPREDICT`（零鉴权，官方公开）。
 * 实测 2026-10-15：最新一条 2026-10-15 新北洋（002376），略增。
 *
 * 你需要知道的（**两个口径千万别混，混了会读反**）：
 * 1. `PREDICT_TYPE`（"略增"/"首亏"…）是**公司自己在公告里用的措辞**，按**同比**算。
 * 2. `PREDICT_RATIO_LOWER/UPPER`（-50.18 / -25）是**环比**上一报告期的变动。
 *    实测那条：同比 +31.9%（所以"略增"），环比 -25% ~ -50%（三季度 EPS 比上半年低）。
 *    **只显示一个数就会把"略增"读成"大幅下滑"**，所以两个都要显示并且标清。
 * 3. **一次预告按指标拆多行**（每股收益 / 净利润 / 营业收入…）。同一只票会出���多行，
 *    页面要么按票聚合，要么明说「这是按指标拆的」。这里保留原始行，让页面自己决定。
 * 4. `PREDICT_TYPE` 的措辞是**公司口径不是我们的判断**——页面上原样显示，不改写、
 *    不加"利好/利空"的颜色以外的东西。要给倾向也是**我们的读法**，要标出来。
 */

/** 预告类型（公司公告里的措辞，原样保留）。 */
export type ForecastKind =
  | "预增"
  | "略增"
  | "续盈"
  | "扭亏"
  | "持平"
  | "略减"
  | "首亏"
  | "续亏"
  | "不确定"
  | string;

export type ForecastRow = {
  id: string;
  code: string;
  name: string;
  /** 公告日 YYYY-MM-DD */
  noticeDate: string;
  /** 报告期 YYYY-MM-DD（比如 2026-09-30 表示三季报） */
  reportDate: string;
  /** 这一行是哪个指标的预告（每股收益 / 净利润 / 营业收入…） */
  item: string;
  /** 公司公告里的措辞，原样 */
  kind: ForecastKind;
  /** 预测值（每股收益时是元，净利润时是元…**单位随指标变，原样保留**） */
  forecast: number | null;
  /** 区间下/上限 */
  forecastLow: number | null;
  forecastHigh: number | null;
  /** 去年同期同指标值（**同比的分母**） */
  samePeriodLastYear: number | null;
  /** 同比变动 %（由我们按预测/去年同期算，不是公司给的口径） */
  yoyPct: number | null;
  /** 环比变动 %（东财给的区间上下限，**不是同比**） */
  qoqLow: number | null;
  qoqHigh: number | null;
  /** 变动原因全文（最有价值的部分——业绩雷都在这里） */
  reason: string | null;
  /** 是不是该指标的最新一条 */
  isLatest: boolean;
};

/**
 * 同比（我们算）：(预测 − 去年同期) / 去年同期。
 *
 * **不提供就返回 null**，不给 0——去年是负数或 0 的时候同比没有意义，
 * 算出来会是个夸张的数（去年 0 → 除零）。那种情况页面显示「同比不可算」。
 */
export function yoyOf(forecast: number | null, lastYear: number | null): number | null {
  if (forecast == null || lastYear == null || lastYear === 0) return null;
  const v = ((forecast - lastYear) / Math.abs(lastYear)) * 100;
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function num(v: unknown): number | null {
  if (v == null || v === "" || v === "--") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function date(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

/** 解析东财业绩预告。坏行跳过并计数——不让一行脏数据毁掉整页。 */
export function parseForecast(rows: readonly Record<string, unknown>[]): { rows: ForecastRow[]; bad: number } {
  const out: ForecastRow[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.SECURITY_CODE === "string" ? raw.SECURITY_CODE.trim() : "";
    const name = typeof raw.SECURITY_NAME_ABBR === "string" ? raw.SECURITY_NAME_ABBR.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const forecast = num(raw.FORECAST_JZ) ?? num(raw.PREDICT_AMT_LOWER);
    const lastYear = num(raw.PREYEAR_SAME_PERIOD);
    out.push({
      id: `${raw.SECUCODE?.toString().includes(".SZ") ? "sz" : raw.SECUCODE?.toString().includes(".BJ") ? "bj" : "sh"}${code}`,
      code,
      name,
      noticeDate: date(raw.NOTICE_DATE),
      reportDate: date(raw.REPORT_DATE),
      item: typeof raw.PREDICT_FINANCE === "string" ? raw.PREDICT_FINANCE : "（指标未知）",
      kind: typeof raw.PREDICT_TYPE === "string" && raw.PREDICT_TYPE ? raw.PREDICT_TYPE : "不确定",
      forecast,
      forecastLow: num(raw.PREDICT_AMT_LOWER),
      forecastHigh: num(raw.PREDICT_AMT_UPPER),
      samePeriodLastYear: lastYear,
      yoyPct: yoyOf(forecast, lastYear),
      qoqLow: num(raw.PREDICT_RATIO_LOWER),
      qoqHigh: num(raw.PREDICT_RATIO_UPPER),
      reason: typeof raw.CHANGE_REASON_EXPLAIN === "string" && raw.CHANGE_REASON_EXPLAIN.trim() ? raw.CHANGE_REASON_EXPLAIN.trim() : null,
      isLatest: raw.IS_LATEST === "T",
    });
  }
  // 公告日倒序（新的在前）；同日按代码排，保证顺序稳定
  out.sort((a, b) => b.noticeDate.localeCompare(a.noticeDate) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}

/**
 * 预告类型的倾向（**这是我们的读法，不是公司的说法**）。
 *
 * 只按公司措辞判，不碰数字：预增/扭亏/续盈 → 偏正；首亏/续亏/略减 → 偏负；
 * 略增/持平/不确定 → 不给倾向。
 *
 * 为什么单独隔一层：页面上要把「公司说略增」和「我们读它偏正」分开显示，
 * 混在一起就成了 AI 在替公司下判断——那是红线的事。
 */
export function forecastTone(kind: ForecastKind): "positive" | "negative" | null {
  if (["预增", "扭亏", "续盈"].includes(kind)) return "positive";
  if (["首亏", "续亏", "略减"].includes(kind)) return "negative";
  return null; // 略增 / 持平 / 不确定 → 不表态
}

/** 按公司聚合成「一只票一条」，指标合并成列表（一次预告按指标拆多行）。 */
export function groupByCompany(rows: readonly ForecastRow[]): {
  code: string;
  name: string;
  noticeDate: string;
  reportDate: string;
  items: ForecastRow[];
}[] {
  const byCode = new Map<string, ForecastRow[]>();
  for (const row of rows) {
    const list = byCode.get(row.code) ?? [];
    list.push(row);
    byCode.set(row.code, list);
  }
  return [...byCode.entries()]
    .map(([code, items]) => ({
      code,
      name: items[0]!.name,
      noticeDate: items[0]!.noticeDate,
      reportDate: items[0]!.reportDate,
      items,
    }))
    .sort((a, b) => b.noticeDate.localeCompare(a.noticeDate) || a.code.localeCompare(b.code));
}
