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

// ── 股东增减持（东财 RPT_SHARE_HOLDER_INCREASE）─────────────────────────
//
// 实测 2026-10-16：河钢资源（000923）河钢集团增持 34 万股、成交均价 14.7015、
// 变动后持股 35.7%，方式「二级市场」。
//
// ⚠️ **`CHANGE_RATE` 不显示**：实测那条 DIRECTION=「增持」，CHANGE_NUM=+34（万股），
// 但 CHANGE_RATE=-5.9361、CHANGE_FREE_RATIO=+0.05——**三个字段两个方向**，口径对不上
// （不是简单反号）。这种字段摆上页面就是误导，所以只认 DIRECTION + CHANGE_NUM
// + HOLD_RATIO（变动后持股）+ TRADE_AVERAGE_PRICE + MARKET（方式）。

export type HolderTrade = {
  id: string;
  code: string;
  name: string;
  noticeDate: string;
  /** 变动区间起/止 */
  startDate: string;
  endDate: string;
  /** 增持 / 减持（东财原样） */
  direction: string;
  holder: string;
  /** 变动股数（万股，正数；方向看 direction） */
  shares: number | null;
  /** 变动后持股比例 % */
  holdRatio: number | null;
  /** 公告披露的成交均价（元）；很多公告不披露 → null */
  avgPrice: number | null;
  /** 变动方式：二级市场 / 大宗交易 / 协议转让… */
  channel: string | null;
  closePrice: number | null;
};

/** 增减持方向倾向。只认「增持/减持」两个字，别的措辞不表态。 */
export function holderTone(direction: string): "positive" | "negative" | null {
  if (direction === "增持") return "positive";
  if (direction === "减持") return "negative";
  return null;
}

export function parseHolderTrades(rows: readonly Record<string, unknown>[]): {
  rows: HolderTrade[];
  bad: number;
} {
  const out: HolderTrade[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.SECURITY_CODE === "string" ? raw.SECURITY_CODE.trim() : "";
    const name = typeof raw.SECURITY_NAME_ABBR === "string" ? raw.SECURITY_NAME_ABBR.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const secucode = typeof raw.SECUCODE === "string" ? raw.SECUCODE : "";
    const prefix = secucode.includes(".SZ") ? "sz" : secucode.includes(".BJ") ? "bj" : "sh";
    out.push({
      id: `${prefix}${code}`,
      code,
      name,
      noticeDate: date(raw.NOTICE_DATE),
      startDate: date(raw.START_DATE),
      endDate: date(raw.END_DATE),
      direction: typeof raw.DIRECTION === "string" && raw.DIRECTION ? raw.DIRECTION : "（方向未知）",
      holder: typeof raw.HOLDER_NAME === "string" ? raw.HOLDER_NAME.trim() : "（股东未披露）",
      shares: num(raw.CHANGE_NUM),
      holdRatio: num(raw.HOLD_RATIO),
      avgPrice: num(raw.TRADE_AVERAGE_PRICE) ?? num(raw.REAL_PRICE),
      channel: typeof raw.MARKET === "string" && raw.MARKET ? raw.MARKET : null,
      closePrice: num(raw.CLOSE_PRICE),
    });
  }
  out.sort((a, b) => b.noticeDate.localeCompare(a.noticeDate) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}

// ── 机构调研（东财 RPT_ORG_SURVEYNEW，汇总模式）─────────────────────────
//
// 实测 2026-10-16：京东方A（000725）10-15 接待，特定对象调研+现场参观，
// 接待对象南方基金等（SUM=3 家）。
//
// **汇总模式**：filter 带 (IS_SOURCE="1")(NUMBERNEW="1")，一次调研一行，
// SUM 是参与机构家数。detail 模式（一家机构一行）没接——那一层要看原始记录表，
// 而很多记录表不写机构类型和人名（skill 文档原文），接了也是半截数据。

export type Survey = {
  id: string;
  code: string;
  name: string;
  noticeDate: string;
  /** 实际接待日（通常早于公告日几天） */
  receiveDate: string;
  receiveEndDate: string;
  /** 接待对象（第一家/汇总描述） */
  object: string | null;
  /** 参与机构家数 */
  orgCount: number | null;
  /** 调研方式：「特定对象调研,现场参观」 */
  way: string | null;
  place: string | null;
};

export function parseSurveys(rows: readonly Record<string, unknown>[]): { rows: Survey[]; bad: number } {
  const out: Survey[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.SECURITY_CODE === "string" ? raw.SECURITY_CODE.trim() : "";
    const name = typeof raw.SECURITY_NAME_ABBR === "string" ? raw.SECURITY_NAME_ABBR.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const secucode = typeof raw.SECUCODE === "string" ? raw.SECUCODE : "";
    const prefix = secucode.includes(".SZ") ? "sz" : secucode.includes(".BJ") ? "bj" : "sh";
    out.push({
      id: `${prefix}${code}`,
      code,
      name,
      noticeDate: date(raw.NOTICE_DATE),
      receiveDate: date(raw.RECEIVE_START_DATE),
      receiveEndDate: date(raw.RECEIVE_END_DATE),
      object: typeof raw.RECEIVE_OBJECT === "string" && raw.RECEIVE_OBJECT ? raw.RECEIVE_OBJECT.trim() : null,
      orgCount: num(raw.SUM),
      way: typeof raw.RECEIVE_WAY_EXPLAIN === "string" && raw.RECEIVE_WAY_EXPLAIN ? raw.RECEIVE_WAY_EXPLAIN.trim() : null,
      place: typeof raw.RECEIVE_PLACE === "string" && raw.RECEIVE_PLACE ? raw.RECEIVE_PLACE.trim() : null,
    });
  }
  out.sort((a, b) => b.noticeDate.localeCompare(a.noticeDate) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}

// ── 股票回购（东财 RPTA_WEB_GETHGLIST_NEW）─────────────────────────────
//
// 实测 2026-10-16：三花智控（002050）实施中，计划回购 2~4 亿元、334~668 万股，
// 价格上限 59.88 元；已回购 581.3 万股 / 2.08 亿元（截至 09-22 公告）。
//
// ⚠️ **代码字段叫 DIM_SCODE 不叫 SECURITY_CODE**（这张表的命名和别的不一样）。
// ⚠️ **进度码只映射实测确认的三个**（001 董事会预案 / 002 股东大会通过 /
// 004 实施中），其余显示原码 + 「（码位未识别）」——skill 文档提到还有 007/008
// 两个连东财自己页面都不显示名称的码，不猜。

export type Buyback = {
  id: string;
  code: string;
  name: string;
  /** 进度码（东财原样，如 "004"） */
  progressCode: string;
  /** 进度中文名；认不出给 null（页面显示原码） */
  progress: string | null;
  planStart: string;
  planEnd: string;
  /** 价格上限（元） */
  priceCap: number | null;
  /** 计划回购股数区间（股） */
  sharesLower: number | null;
  sharesUpper: number | null;
  /** 计划回购金额区间（元） */
  amountLower: number | null;
  amountUpper: number | null;
  /** 已回购股数 / 金额（未开始实施为 null） */
  doneShares: number | null;
  doneAmount: number | null;
  /** 已回购成交价区间（元） */
  donePriceLow: number | null;
  donePriceHigh: number | null;
  /** 最新公告日 */
  latestNotice: string;
  objective: string | null;
};

const BUYBACK_PROGRESS: Record<string, string> = {
  "001": "董事会预案",
  "002": "股东大会通过",
  "004": "实施中",
};

export function parseBuybacks(rows: readonly Record<string, unknown>[]): { rows: Buyback[]; bad: number } {
  const out: Buyback[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.DIM_SCODE === "string" ? raw.DIM_SCODE.trim() : "";
    const name = typeof raw.SECURITYSHORTNAME === "string" ? raw.SECURITYSHORTNAME.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const secucode = typeof raw.SECUCODE === "string" ? raw.SECUCODE : "";
    const prefix = secucode.includes(".SZ") ? "sz" : secucode.includes(".BJ") ? "bj" : "sh";
    const progressCode = typeof raw.REPURPROGRESS === "string" ? raw.REPURPROGRESS : "";
    out.push({
      id: `${prefix}${code}`,
      code,
      name,
      progressCode,
      progress: BUYBACK_PROGRESS[progressCode] ?? null,
      planStart: date(raw.REPURSTARTDATE),
      planEnd: date(raw.REPURENDDATE),
      priceCap: num(raw.REPURPRICECAP),
      sharesLower: num(raw.REPURNUMLOWER),
      sharesUpper: num(raw.REPURNUMCAP),
      amountLower: num(raw.REPURAMOUNTLOWER),
      amountUpper: num(raw.REPURAMOUNTLIMIT),
      doneShares: num(raw.REPURNUM),
      doneAmount: num(raw.REPURAMOUNT),
      donePriceLow: num(raw.REPURPRICELOWER1),
      donePriceHigh: num(raw.REPURPRICECAP1),
      latestNotice: date(raw.UPDATEDATE) || date(raw.NOTICEDATE),
      objective: typeof raw.REPUROBJECTIVE === "string" && raw.REPUROBJECTIVE.trim() ? raw.REPUROBJECTIVE.trim() : null,
    });
  }
  out.sort((a, b) => b.latestNotice.localeCompare(a.latestNotice) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}

/**
 * 回购进度倾向：完成/实施中是公司在买（偏正），停止实施/否决是黄了（偏负）。
 * 004（实施中）是实测确认的；003/005/006 来自 skill 文档列的六个 progress 名
 * （文档口径，未实测到样本）——所以倾向给了，中文名却不显示（没实测的不映射）。
 */
export function buybackTone(progressCode: string): "positive" | "negative" | null {
  if (progressCode === "004" || progressCode === "006") return "positive";
  if (progressCode === "003" || progressCode === "005") return "negative";
  return null; // 001/002 只是流程节点，007/008 认不出
}

// ── 股权质押（东财 RPT_CSDC_LIST，中国结算周频）────────────────────────
//
// 实测 2026-10-16：TRADE_DATE=2026-10-09（上周五，**周频**），信通电子（001388）
// 质押比例 0.23%、质押市值 1063.26 万元。
//
// ⚠️ **排序字段是 TRADE_DATE 不是 NOTICE_DATE**——10-15 我拿 NOTICE_DATE 探，
//    东财直接返回 9501「排序列不存在」，白探了一轮。
// ⚠️ **只覆盖沪深**（skill 实测全市场 2212 条没有北交所），北交所票不会出现在
//    这张表里——页面显示「只有沪深」而不是让人以为北交所没质押。

export type Pledge = {
  /** 统计日（中国结算按周发布，通常周五）YYYY-MM-DD */
  date: string;
  id: string;
  code: string;
  name: string;
  /** 行业（东财行业分类） */
  industry: string | null;
  /** 质押股数占总股本 % */
  pledgeRatio: number | null;
  /** 质押市值（万元） */
  pledgeMktCap: number | null;
  /** 质押笔数 */
  pledgeCount: number | null;
};

export function parsePledges(rows: readonly Record<string, unknown>[]): { rows: Pledge[]; bad: number } {
  const out: Pledge[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.SECURITY_CODE === "string" ? raw.SECURITY_CODE.trim() : "";
    const name = typeof raw.SECURITY_NAME_ABBR === "string" ? raw.SECURITY_NAME_ABBR.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const secucode = typeof raw.SECUCODE === "string" ? raw.SECUCODE : "";
    const prefix = secucode.includes(".SZ") ? "sz" : secucode.includes(".BJ") ? "bj" : "sh";
    out.push({
      date: date(raw.TRADE_DATE),
      id: `${prefix}${code}`,
      code,
      name,
      industry: typeof raw.INDUSTRY === "string" && raw.INDUSTRY ? raw.INDUSTRY : null,
      pledgeRatio: num(raw.PLEDGE_RATIO),
      pledgeMktCap: num(raw.PLEDGE_MARKET_CAP),
      pledgeCount: num(raw.PLEDGE_DEAL_NUM),
    });
  }
  // 质押比例降序（风险高的在前）。null 排最后——不拿 0 当「没质押」，也不拿它打头。
  const ratio = (p: Pledge): number => p.pledgeRatio ?? -1;
  out.sort((a, b) => ratio(b) - ratio(a) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}

// ── 新股申购日历（东财 RPTA_APP_IPOAPPLY）─────────────────────────────
//
// 实测 2026-10-16：皇冠新材，橡胶和塑料制品业，顶格申购需配市值 13.5 万元，
// 发行市盈率 25.87 / 行业 27.65。
//
// ⚠️ **板块取 MARKET || MARKET_TYPE_NEW**：前者是「深交所主板/创业板」这类准确
//    板块；后者会把未上市的标成「深交所其他」，**但北交所新股只有后者有值**
//    （skill 原文，实测皇冠新材是深交所）。
// ⚠️ **issue_price 定价前是 null 或 0**——0 不是「免费」，要当 null。

export type IpoItem = {
  id: string;
  code: string;
  name: string;
  /** 申购代码（和证券代码不同） */
  applyCode: string | null;
  board: string | null;
  industry: string | null;
  applyDate: string;
  /** 中签号公布日 */
  ballotDate: string;
  /** 缴款日 */
  payDate: string;
  /** 上市日（未上市为 null） */
  listingDate: string;
  /** 发行价（元）；定价前为 null */
  issuePrice: number | null;
  /** 发行市盈率 / 行业市盈率 */
  issuePe: number | null;
  industryPe: number | null;
  /** 顶格申购需配市值（万元） */
  topApplyMktCap: number | null;
  /** 网上中签率 %（未公布为 null） */
  winRate: number | null;
};

export function parseIpos(rows: readonly Record<string, unknown>[]): { rows: IpoItem[]; bad: number } {
  const out: IpoItem[] = [];
  let bad = 0;
  for (const raw of rows) {
    const code = typeof raw.SECURITY_CODE === "string" ? raw.SECURITY_CODE.trim() : "";
    const name = typeof raw.SECURITY_NAME === "string" ? raw.SECURITY_NAME.trim() : "";
    if (!/^\d{6}$/.test(code) || !name) {
      bad += 1;
      continue;
    }
    const secucode = typeof raw.SECUCODE === "string" ? raw.SECUCODE : "";
    const prefix = secucode.includes(".SZ") ? "sz" : secucode.includes(".BJ") ? "bj" : "sh";
    const price = num(raw.ISSUE_PRICE);
    // MARKET（准确板块）优先；北交所新股只有 MARKET_TYPE_NEW 有值，回退取它。
    // ⚠️ 不能写 `a ?? b` 直接嵌在对象字面量里和三目混用——node 的 strip-types
    // 对 ?? 和三目/算术混用要求显式括号（2026-10-16 实测报
    // "Nullish coalescing operator requires parens when mixing"）。
    let board: string | null = null;
    if (typeof raw.MARKET === "string" && raw.MARKET) board = raw.MARKET;
    else if (typeof raw.MARKET_TYPE_NEW === "string" && raw.MARKET_TYPE_NEW) board = raw.MARKET_TYPE_NEW;
    out.push({
      id: `${prefix}${code}`,
      code,
      name,
      applyCode: typeof raw.APPLY_CODE === "string" && raw.APPLY_CODE ? raw.APPLY_CODE : null,
      board,
      industry: typeof raw.INDUSTRY_NAME === "string" && raw.INDUSTRY_NAME ? raw.INDUSTRY_NAME : null,
      applyDate: date(raw.APPLY_DATE),
      ballotDate: date(raw.BALLOT_NUM_DATE),
      payDate: date(raw.BALLOT_PAY_DATE),
      listingDate: date(raw.LISTING_DATE),
      // 0 不是「免费」：定价前东财填 null 或 0，都当没定价
      issuePrice: price != null && price > 0 ? price : null,
      issuePe: num(raw.AFTER_ISSUE_PE),
      industryPe: num(raw.INDUSTRY_PE),
      topApplyMktCap: num(raw.TOP_APPLY_MARKETCAP),
      winRate: num(raw.ONLINE_ISSUE_LWR),
    });
  }
  out.sort((a, b) => b.applyDate.localeCompare(a.applyDate) || a.code.localeCompare(b.code));
  return { rows: out, bad };
}
