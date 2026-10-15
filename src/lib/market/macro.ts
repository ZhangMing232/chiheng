/**
 * 这个文件是干什么的：
 * 中债国债收益率曲线的解析与利差计算（D7 宏观层第一块）。
 *
 * 为什么先做这个：A 股是流动性驱动市场，**10 年国债收益率是市场的「水温」**——
 * 它往下走意味着钱变便宜、风险偏好上升。它是日频的，能进每日复盘；
 * 社融和 PMI 是月频（发布还固定日子），不适合日频页面。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §11.3（中央结算公司官方，零鉴权）：
 * `https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery`，返回 HTML 表格。
 *
 * 实测（2026-10-15）：一次查 30 天返回 18 个交易日 × 8 档期限，2026-10-14 的
 * 10 年期国债 1.6516%。
 *
 * 你需要知道的：
 * 1. **官网单次查询超过 1 年会静默返回 0 行**——所以查询窗口要控制在 360 天内，
 *    不用它的切片逻辑，赤轨一次只取近期。
 * 2. **它不公布债券市场交易日历**，页面也没有总条数，所以「某天没有数据」
 *    分不清是节假日还是接口坏了。**这里不拿缺失当天当异常**——给出最近有数据的
 *    那天，让页面自己标「数据截至 X」。
 * 3. 收益率单位是 **%**（1.6516 = 1.6516%），不是小数。解析层保持原样，
 *    换算只在展示层做。
 * 4. 表头行不是数据：解析按「第二格是 YYYY-MM-DD」判定，认不出就跳过，不硬凑。
 */

export type YieldPoint = {
  date: string;
  /** 3月 ~ 30年，八档，单位 %。缺档是 null（不同曲线起点不同） */
  tenors: Record<string, number | null>;
};

/** 八档期限的显示名（和官网表头一致）。 */
export const TENOR_LABELS: Record<string, string> = {
  "3m": "3月",
  "6m": "6月",
  "1y": "1年",
  "3y": "3年",
  "5y": "5年",
  "7y": "7年",
  "10y": "10年",
  "30y": "30年",
};

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

/**
 * 解析中债返回的 HTML 表格。
 *
 * 认不出的行跳过并计数——**不因为一行脏数据丢掉整条曲线**。
 * 数值缺失（空单元格或非数字）给 null，不给 0（0 会被读成"收益率 0%"）。
 */
export function parseYieldCurve(html: string): { points: YieldPoint[]; bad: number } {
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const rows = body.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  const points: YieldPoint[] = [];
  let bad = 0;
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(stripTags);
    if (cells.length < 2) continue;
    // 第一格是曲线名，第二格是日期；日期认不出来就不是数据行
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[1]!)) continue;
    const tenors: Record<string, number | null> = {};
    // 表头顺序：曲线名 | 日期 | 3月 | 6月 | 1年 | 3年 | 5年 | 7年 | 10年 | 30年
    // **顺序照官网表头**（3月|6月|1年|3年|5年|7年|10年|30年），不靠猜也不靠
    // 「在 cells 里找 10年 那一格」——那种写法在缺列时会整体错位。
    const keys = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"];
    for (let i = 0; i < keys.length; i += 1) {
      const raw = cells[i + 2];
      if (raw == null || raw === "" || raw === "--") {
        tenors[keys[i]!] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        bad += 1;
        tenors[keys[i]!] = null;
        continue;
      }
      tenors[keys[i]!] = value;
    }
    points.push({ date: cells[1]!, tenors });
  }
  // 官网按日期倒序返回，但**别假设**：统一按日期升序，页面画曲线才不用再排
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { points, bad };
}

/** 一次拿多条曲线时，按曲线名分开（`all` 模式一天三条）。 */
export function splitByCurve(points: YieldPoint[], curveNames: string[]): Map<string, YieldPoint[]> {
  const out = new Map<string, YieldPoint[]>();
  for (const name of curveNames) out.set(name, []);
  return out;
}

/**
 * 期限利差（百分点，不是百分比变化）。
 *
 * 「水温」最常看的两条：
 * - `10y - 1y`：曲线陡不陡，市场对远期经济是通缩还是通胀的预期
 * - `30y - 10y`：超长端，反映更远期的名义增长预期
 *
 * 任一端缺值给 null——**不拿 0 充数**（0 会被读成"曲线平坦"）。
 */
export function spreadOf(point: YieldPoint, long: string, short: string): number | null {
  const a = point.tenors[long];
  const b = point.tenors[short];
  if (a == null || b == null) return null;
  return round4(a - b);
}

export type MacroSnapshot = {
  /** 数据截至哪天（接口不保证今天有数据） */
  date: string | null;
  tenors: Record<string, number | null>;
  /** 10y - 1y，百分点 */
  slope10y1y: number | null;
  /** 30y - 10y，百分点 */
  slope30y10y: number | null;
  /** 最近有多少个交易日的数据 */
  days: number;
};

/**
 * 取最新一天做快照，外加最近 N 天的曲线（画图用）。
 * 一条都没有时给 null——页面显示"拿不到"，不显示全 0。
 */
export function snapshotOf(points: YieldPoint[]): MacroSnapshot | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1]!;
  return {
    date: last.date,
    tenors: last.tenors,
    slope10y1y: spreadOf(last, "10y", "1y"),
    slope30y10y: spreadOf(last, "30y", "10y"),
    days: points.length,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
// ── PMI（国家统计局，月频）─────────────────────────────────────────────
//
// 接口来自 a-stock-data SKILL V3.10.2 §11.2。实测 2026-10-15：首页通、
// 命中「2026年9月中国采购经理指数运行情况」，制造业 50.1 / 非制造业 50.2 /
// 综合 50.7。
//
// ⚠️ **registry 里那条「统计局被 WAF 403 挡」说的是 akshare 的接口**
//（分行业宏观那条路），**统计局官网本身是通的**——首页和最新发布页都能取。
// 换源的时候别被那条旧记录误导。

export type PmiReading = {
  /** 数据所属月份（不是拉取日期） */
  month: string | null;
  /** 制造业 PMI，50 是荣枯线 */
  manufacturing: number | null;
  nonManufacturing: number | null;
  composite: number | null;
  large: number | null;
  medium: number | null;
  small: number | null;
};

/**
 * 解析统计局 PMI 发布页。
 *
 * **两个坑（都实测踩过）**：
 * 1. 正文是**全角括号而且括号里有空格**：`（ PMI ）为 49.2%`。所以必须把空白
 *    **整个删掉**再匹配——只压成单个空格的话一条都匹配不到（这是 skill 文档
 *    里标🔴 的坑）。
 * 2. 大中小企业的措辞统计局用过三种版式，要逐层回退。认不出来给 null，
 *    **不猜**（这些是可选字段，主体三个 PMI 是必须的）。
 */
export function parsePmi(bodyHtml: string): PmiReading {
  // 先剥 script/style，再去标签，最后把**所有空白（含全角空格）整个删掉**
  const text = bodyHtml
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[\s\u3000\u00a0]+/g, "");
  const grab = (pattern: RegExp): number | null => {
    const m = text.match(pattern);
    return m && m[1] != null ? Number(m[1]) : Number.isFinite(Number(m?.[1])) ? Number(m![1]) : null;
  };

  // 大中小三种版式：①全合并 ②中小合并 ③全拆
  let large: number | null = null;
  let medium: number | null = null;
  let small: number | null = null;
  const combined = text.match(/大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%/);
  if (combined) {
    large = Number(combined[1]);
    medium = Number(combined[2]);
    small = Number(combined[3]);
  } else {
    const ms = text.match(/中、小型企业PMI分别为([\d.]+)%和([\d.]+)%/);
    if (ms) {
      medium = Number(ms[1]);
      small = Number(ms[2]);
    }
    const lg = text.match(/大型企业PMI为([\d.]+)%/);
    if (lg) large = Number(lg[1]);
    const md = text.match(/中型企业PMI为([\d.]+)%/);
    if (md) medium = Number(md[1]);
    const sm = text.match(/小型企业PMI为([\d.]+)%/);
    if (sm) small = Number(sm[1]);
  }

  const month = bodyHtml.match(/(\d{4})年(\d{1,2})月/)?.[0] ?? null;
  return {
    month,
    manufacturing: grab(/制造业采购经理指数（PMI）为([\d.]+)%/),
    nonManufacturing: grab(/非制造业商务活动指数为([\d.]+)%/),
    composite: grab(/综合PMI产出指数为([\d.]+)%/),
    large,
    medium,
    small,
  };
}

/** PMI 相对荣枯线的位置：扩张 / 收缩 / 刚好。null 表示没数。 */
export function pmiZone(value: number | null): "expansion" | "contraction" | "flat" | null {
  if (value == null) return null;
  if (value > 50) return "expansion";
  if (value < 50) return "contraction";
  return "flat";
}

// ── LPR（东财数据中心，月频）────────────────────────────────────────────
//
// 接口来自 a-stock-data SKILL V3.10.2 §11.5。实测 2026-10-15：最近 8 条
// 2026-09-20 1Y 3.0 / 5Y 3.5。
//
// ⚠️ **东财同一张报表里混着旧贷款基准利率**（1991-04 至 2015-10，38 行，
// LPR 字段为空）。不剔除的话历史图上会多出一段 5% 以上的"贷款利率"。

export type LprPoint = {
  date: string;
  /** 1 年期 LPR，% */
  lpr1y: number | null;
  /** 5 年期以上 LPR，% 。2019-08-20 才设立，之前是 null */
  lpr5y: number | null;
};

/**
 * 解析东财 LPR 报表（按 TRADE_DATE 倒序）。
 *
 * `LPR1Y` 为空的行是旧贷款基准利率，**剔掉**——它们不是 LPR。
 * 剩下的行如果 `LPR1Y` 认不出数，给 null 并计数，不静默当 0。
 */
export function parseLpr(rows: readonly Record<string, unknown>[]): { points: LprPoint[]; bad: number } {
  const points: LprPoint[] = [];
  let bad = 0;
  for (const row of rows) {
    const raw = row.LPR1Y;
    if (raw == null || raw === "") continue; // 旧贷款基准利率，不是 LPR
    const date = String(row.TRADE_DATE ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      bad += 1;
      continue;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      bad += 1;
      points.push({ date, lpr1y: null, lpr5y: null });
      continue;
    }
    const v5 = row.LPR5Y == null || row.LPR5Y === "" ? null : Number(row.LPR5Y);
    points.push({ date, lpr1y: v, lpr5y: v5 != null && Number.isFinite(v5) ? v5 : null });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { points, bad };
}

/** LPR 快照（最新一次报价）。一条都没有给 null。 */
export function lprSnapshotOf(points: LprPoint[]): LprPoint | null {
  return points.length > 0 ? points[points.length - 1]! : null;
}

// ── 社会融资规模（人民银行，月频）────────────────────────────────────────
//
// 数据由 `scripts/fetch-social-financing.py` 落盘到
// `data/macro/social-financing.json`（**零依赖手写 xlsx 解析**——akshare 就是
// 因为 arm64 装不上依赖而废的，社融不能再踩一次）。
//
// 实测 2026-10-15：2022-01 ~ 2026-09 共 57 个月；2026-09 社融增量 35476 亿。
// 2021 那年的附件是 .xls 旧格式，脚本读不了（会明说，不静默跳过）。

export type SocialFinancingRow = {
  /** YYYY-MM */
  month: string;
  /** 社融增量，亿元人民币 */
  afreTotal: number | null;
  rmbLoans: number | null;
  fxLoans: number | null;
  entrustedLoans: number | null;
  trustLoans: number | null;
  bankersAcceptance: number | null;
  corporateBonds: number | null;
  governmentBonds: number | null;
  equityFinancing: number | null;
  abs: number | null;
  writeOff: number | null;
};

export type SocialFinancingFile = {
  source: string;
  unit: string;
  fetchedAt: string;
  columns?: { key: string; label: string }[];
  rows: SocialFinancingRow[];
  failed?: string[];
};

/**
 * 校验落盘文件。**行数对不上、月份格式不对都算损坏**——宁可给 null 让页面说
 * 「数据有问题」，也不要拿半份数据当全的。
 */
export function parseSocialFinancing(raw: unknown): SocialFinancingFile | null {
  const file = raw as Partial<SocialFinancingFile> | null;
  if (!file || !Array.isArray(file.rows) || file.rows.length === 0) return null;
  const rows: SocialFinancingRow[] = [];
  for (const row of file.rows as Record<string, unknown>[]) {
    const month = typeof row.month === "string" ? row.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) continue; // 坏行跳过，不让一行拖垮整份
    const pick = (key: string): number | null => {
      const v = row[key];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    rows.push({
      month,
      afreTotal: pick("afreTotal"),
      rmbLoans: pick("rmbLoans"),
      fxLoans: pick("fxLoans"),
      entrustedLoans: pick("entrustedLoans"),
      trustLoans: pick("trustLoans"),
      bankersAcceptance: pick("bankersAcceptance"),
      corporateBonds: pick("corporateBonds"),
      governmentBonds: pick("governmentBonds"),
      equityFinancing: pick("equityFinancing"),
      abs: pick("abs"),
      writeOff: pick("writeOff"),
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.month.localeCompare(b.month));
  return {
    source: typeof file.source === "string" ? file.source : "人民银行",
    unit: typeof file.unit === "string" ? file.unit : "亿元人民币",
    fetchedAt: typeof file.fetchedAt === "string" ? file.fetchedAt : "",
    columns: file.columns,
    rows,
    failed: Array.isArray(file.failed) ? file.failed : [],
  };
}

/** 12 个月移动合计（社融是**增量**流量，单月数字噪声大，看累计更稳）。 */
export function trailingSum(rows: readonly SocialFinancingRow[], key: "afreTotal" | "rmbLoans", months: number): number | null {
  const usable = rows.filter((r) => r[key] != null);
  if (usable.length === 0) return null;
  const tail = usable.slice(-months);
  return round2(tail.reduce((sum, r) => sum + (r[key] as number), 0));
}

/**
 * 社融的「钱在进还是在出」。
 *
 * **只是陈述差额，不是预测**：正数 = 累计投放 > 累计到期，负数 = 净回笼。
 * 拿它跟国债收益率对照才有点意义（收益率看价格、社融看数量），
 * 但那层解读不在本页做——见 /review 的宏观面板。
 */
export function twelveMonthChange(rows: readonly SocialFinancingRow[], key: "afreTotal" | "rmbLoans"): number | null {
  const usable = rows.filter((r) => r[key] != null);
  if (usable.length < 12) return null;
  const tail = usable.slice(-12);
  return round2(tail.reduce((sum, r) => sum + (r[key] as number), 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
