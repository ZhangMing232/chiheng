/**
 * 这个文件是干什么的：
 * 数据源端点目录。**把散在注释里的口径陷阱搬进结构化表**，让代码和 AI 都能查。
 *
 * 你需要知道的：
 *
 * 1. **为什么要有它**：这些坑过去只活在注释里（`providers/tencent.ts` 的科创板成交额、
 *    `providers/sina.ts` 的字段缺失、`cninfo.ts` 的六个坑）。注释人能读、**机器和 AI 读不到**，
 *    结果就是同一个坑被踩第二次——据点就是 2026-10-11 写 `cninfo.ts` 时踩的时区坑
 *    （北京时间毫秒被当成 UTC，整批公告日期错一天）。
 *
 * 2. **`traps` 字段必须带出处**。写"注意单位"没用，要写"科创板给元、主板给万元（差 1e4），
 *    见 providers/tencent.ts:101-127"。能回溯到实测记录，这条陷阱才可信。
 *
 * 3. **`critical` 的语义**（学 Vibe-Research）：关键端点失败 → 本次结果置 `incomplete`，
 *    **不编值、不拿旧值冒充**，写明缺什么、试过哪些备源。这比"静默给个 0"危险得多——
 *    0 会被读成"知道了"，而真实情况是"没取到"。
 *
 * 4. **`market` 字段现在只填 "a"**，但类型已经留成 `"a" | "hk" | "us"`。将来接美股/港股
 *    不用改结构，只加条目。（P3 多市场用）
 *
 * 5. **纯数据 + 纯函数，零 I/O**。它会被 `providers/index.ts` 引用，而后者在 60 秒热路径上，
 *    所以这个文件的 import 必须零副作用。
 */

/** 市场标识。现在只有 A 股，字段为 P3 多市场预留。 */
export type MarketId = "a" | "hk" | "us";

/** 数据源。 */
export type SourceId = "tencent" | "sina" | "eastmoney" | "cninfo" | "tushare" | "akshare" | "bse" | "cffex" | "baostock";

/**
 * 合规级别。
 * - `official`：官方/法定披露平台（如巨潮=证监会指定）
 * - `public-web`：公开网页接口（无授权声明，注意频率）
 * - `licensed`：需授权/付费（如 tushare 积分墙）
 */
export type Compliance = "official" | "public-web" | "licensed";

export type EndpointKind =
  | "universe"
  | "kline"
  | "index"
  | "flow"
  | "announcement"
  | "fundamental"
  | "valuation"
  | "news"
  | "calendar";

export type Endpoint = {
  id: string;
  title: string;
  source: SourceId;
  market: MarketId;
  compliance: Compliance;
  kind: EndpointKind;
  /** 关键端点：失败则本次 incomplete，不编值不拿旧值冒充。 */
  critical: boolean;
  /** 主要数值字段的单位。换算前先看这里。 */
  unit: string;
  /** 口径陷阱，每条带实测出处。 */
  traps: string[];
  /** 实现位置，便于反查。 */
  fetcher: string;
};

/**
 * 数据源的中文名。给「腾讯 · 3 分钟前」这种页面文案用。
 *
 * 放在这里而不是 `data-status.ts`，是因为**名字也属于口径**——同一个源在两个地方写名字，
 * 改了一个没改另一个就会出现「页面上写腾讯、日志里写 tx」这种漂移。单一来源更省心。
 */
export const SOURCE_NAMES: Record<SourceId, string> = {
  tencent: "腾讯",
  sina: "新浪财经",
  eastmoney: "东方财富",
  cninfo: "巨潮资讯",
  tushare: "Tushare",
  akshare: "AKShare",
  bse: "北交所",
  cffex: "中金所",
  baostock: "证券宝 baostock",
};

export const ENDPOINTS: Endpoint[] = [
  // ── 行情快照 ────────────────────────────────────────────────
  {
    id: "tencent.universe",
    title: "腾讯全市场快照（A股）",
    source: "tencent",
    market: "a",
    compliance: "public-web",
    kind: "universe",
    critical: true,
    unit: "万元（科创板为元）",
    traps: [
      "科创板成交额单位是**元**、主板是**万元**，差 1e4；已由 normalizeStarRow 换算，见 providers/tencent.ts:101-127（有实测键凯科技 688356 佐证）",
      "**不含北交所**（348 只只在新浪有），两边口径必须一致，否则同一策略在两个源上选出不同的票，见 providers/index.ts:26-35",
      "全市场只数 < 4000 视为拉取失败——残缺名单比报错更危险，因为下游会当成'市场就这么大'，见 providers/index.ts:19 MIN_UNIVERSE",
      "批量分页拉久了会被 WAF 挡 501（历史事故：缓存是旧的、页面照常显示、**无任何预警**，等到结算卡住才发现），分页逻辑见 providers/tencent.ts:fetchPage",
      "**注意**：preflight.ts 刻意保持纯本地不联网（见其文件头第 1 条），所以**没有运行时的源健康探测**——WAF 挡了只能等下游出错才发现。这是赤轨相对 Vibe loader_health.py 的一处真实缺口",
    ],
    fetcher: "providers/tencent.ts:fetchTencentUniverse",
  },
  {
    id: "sina.universe",
    title: "新浪全市场快照（备份源，含北交所）",
    source: "sina",
    market: "a",
    compliance: "public-web",
    kind: "universe",
    critical: false,
    unit: "万元（源给元，代码内 /1e4）",
    traps: [
      "d5/d10/d20/d60/ytd **全为 null**——不是 0 是 null，按 0 算会让所有动量策略失效，见 providers/sina.ts:9-10 与 L55-59",
      "volRatio 恒为 0、inflow 恒为 0（源本身不提供），见 providers/sina.ts:53/60",
      "cap 源给万元需 /1e4、amount 源给元需 /1e4，见 providers/sina.ts:50/61",
      "**降级到新浪时 breakout 与 rebound 整天不出票**（因为 d5/d20 是 null），这是已知后果不是 bug，见 providers/index.ts:47-56",
    ],
    fetcher: "providers/sina.ts:fetchSinaUniverse",
  },
  {
    id: "eastmoney.index",
    title: "东财指数（备份源）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "index",
    critical: false,
    unit: "点",
    traps: [
      "clist 全市场接口**本机不通**，只做指数备份，见 providers/eastmoney.ts:3-7",
    ],
    fetcher: "providers/eastmoney.ts:fetchEastmoneyIndices",
  },

  // ── K 线 ────────────────────────────────────────────────────
  {
    id: "tencent.kline",
    title: "腾讯日 K（不复权 / 前复权）",
    source: "tencent",
    market: "a",
    compliance: "public-web",
    kind: "kline",
    critical: true,
    unit: "元 / 手",
    traps: [
      "**没有备份源**：providers/index.ts:63 的降级只覆盖快照（腾讯→新浪），K 线挂了就是挂了——这是所有端点里唯一无兜底的一项",
      "结算用**不复权**（和买入价同口径），回测用**前复权**，两者不可混用，见 quotes.functions.ts:156-159",
      "缓存落盘 `data/backtest/kline/${id}.json` **无 hash、无拉取时间、无源标记**——这是 P0-3 证据层要补的",
    ],
    fetcher: "quotes.functions.ts:loadKline（web.ifzq.gtimg.cn）",
  },

  // ── 公告 ────────────────────────────────────────────────────
  {
    id: "cninfo.announcement",
    title: "巨潮公告（证监会指定披露平台，法定原文）",
    source: "cninfo",
    market: "a",
    compliance: "official",
    kind: "announcement",
    critical: false,
    unit: "毫秒时间戳（北京时间）",
    traps: [
      "`stock` 参数必须是 `代码,orgId`，**只给代码会静默返回 announcements:null**（不报错，最易误判成'这只票没公告'）",
      "**orgId 只能查不能拼**：实测 gssz0000001 / gssh0600519 / 9900014448 三种格式，见 cninfo.ts:82",
      "防爬触发时返回 **HTML 而非 JSON**，必须检测响应体开头是不是 `{`，见 cninfo.ts:145-150",
      "`announcementTime` 是**北京时间**毫秒，直接 toISOString 会退 8 小时 → **整批日期错一天**（2026-10-11 实测踩过），见 cninfo.ts:112",
      "`adjunctUrl` 是相对路径，要拼 `http://static.cninfo.com.cn/` 才是可打开的 PDF，见 cninfo.ts:118",
    ],
    fetcher: "cninfo.ts:loadCninfoAnnouncements",
  },
  {
    id: "eastmoney.announcement",
    title: "东财公告（巨潮的兜底源）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "announcement",
    critical: false,
    unit: "日期字符串",
    traps: [
      "是**二次加工的 HTML 详情页**，不是法定原文；巨潮打得着时优先巨潮，见 news.ts:305-320",
    ],
    fetcher: "news.ts:loadEastmoneyAnnouncements（np-anotice-stock）",
  },

  // ── 资金流 ──────────────────────────────────────────────────
  {
    id: "eastmoney.flow",
    title: "东财个股资金流历史",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "flow",
    critical: false,
    unit: "元",
    traps: [
      "**历史封顶 120 个交易日**，超出部分拿不到（不是 bug 是接口限制），见 data/backtest/flow 缓存与 build-flow.mjs",
    ],
    fetcher: "flow.ts（RPT_MUTUAL_DEAL_HISTORY）",
  },
  {
    id: "tencent.flow",
    title: "腾讯资金流（行业榜/个股榜）",
    source: "tencent",
    market: "a",
    compliance: "public-web",
    kind: "flow",
    critical: false,
    unit: "万元",
    traps: ["与东财口径不同，两边数值不可直接比较；页面展示须标明来源"],
    fetcher: "flow.ts:261/263（hsfundtab）",
  },

  // ── 基本面 ──────────────────────────────────────────────────
  {
    id: "tushare.financials",
    title: "Tushare 财报（PIT 对齐）",
    source: "tushare",
    market: "a",
    compliance: "licensed",
    kind: "fundamental",
    critical: false,
    unit: "元 / %",
    traps: [
      "**积分墙**（120 分只够日线，财务类要 2000 分，见 tushare.pro/document/1?doc_id=108）；拿不到时走 akshare 东财业绩报表兜底，见 tushare.ts:47",
      "PIT 对齐由 fundamentals.ts:47 pitValue / L67 recentQuarters 保证——历史取不到未来数据，但**未对齐的报告期会让因子前视**，这是比源本身更隐蔽的坑",
    ],
    fetcher: "tushare.ts:callTushare（api.tushare.pro）",
  },
  {
    id: "eastmoney.fundamentals",
    title: "东财业绩报表（Tushare 兜底）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "fundamental",
    critical: false,
    unit: "元 / %",
    traps: [
      "roe/dtYoy/gm/debt 口径见 fundamentals.ts:15-17，与 tushare 的净利润同比口径不同（factors.ts:185-186 有对照说明）",
    ],
    fetcher: "scripts/fetch-fundamentals.py（akshare）",
  },

  // ── 估值历史（2026-10-12 新增，学 Vibe-Research 的 fetch_pe_history） ──
  {
    id: "baostock.valuation",
    title: "证券宝估值历史（PE_TTM / PB / PS / PCF + 换手 + 停牌）",
    source: "baostock",
    market: "a",
    compliance: "public-web",
    kind: "valuation",
    critical: false,
    unit: "倍数 / %（turn 是百分比）",
    traps: [
      "**不支持北交所**，索要 bj 代码是直接报错而不是返回空——这两种表现的处理方式完全相反，见 scripts/fetch-pe-history.py:bs_code",
      "`tradestatus` 是**字符串**：1 = 正常交易，0 = 停牌。算历史分位必须剔除停牌日，否则停牌期间沿用旧估值会被重复计入，把分位算歪，见 scripts/fetch-pe-history.py:write_out",
      "SDK 翻页失败**不抛异常**，`rs.next()` 只返回 False——拿着半截序列当完整序列是最危险的静默错误。单页上限 2000 行，5 年日线约 1220 行安全，见脚本文件头第 3 条（移植自 Vibe `sources/baostock_src.py` 的 bs_paging_error 注记）",
      "数据 **T+1 可见**：2026-10-12 实测拉取 600519 最新只到 10-09**（10-10/11 是周末），当天收盘当天拿不到——和只差分时精度的行情快照**不同**，端到端延迟在这里是一整个交易日，见 scripts/fetch-pe-history.py:main",
      "**离线脚本不是在线接口**：产物落在 data/fundamentals/pe-<code>.json（data 不在 git 里），换机器或没跑过脚本就是**没有**而不是空——页面必须写成缺口，见 pe-history.ts:loadValuationHistory（读不到返回 null）",
      "必须用装了 baostock 的隔离环境跑，**系统 python3（3.9.6）里没有这个包**，漏换解释器时报错是 ModuleNotFoundError 而不是数据异常，见 scripts/fetch-pe-history.py:main",
    ],
    fetcher: "scripts/fetch-pe-history.py → src/lib/market/pe-history.ts:loadValuationHistory",
  },

  // ── 其他 ────────────────────────────────────────────────────
  {
    id: "eastmoney.hotmoney",
    title: "东财龙虎榜",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "flow",
    critical: false,
    unit: "元",
    traps: ["单源**无备份**：hotmoney.ts:86/100/119 三个端点全走东财 datacenter-web，一个挂了就没有替补"],
    fetcher: "hotmoney.ts（datacenter-web）",
  },
  {
    id: "eastmoney.news",
    title: "东财快讯 / 新闻",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "news",
    critical: false,
    unit: "字符串",
    traps: [
      "**利好/利空由关键词规则判定，不是研报也不是 AI**，见 news.ts:toneOf",
      "只覆盖 A 股；**全球消息（美股/港股/宏观）尚未接入**——news.ts:120 只拉东财 A 股快讯，这是相对 Vibe（A/美/港）最大的覆盖差距，P3 补",
    ],
    fetcher: "news.ts:loadHeadlines",
  },
  {
    id: "cffex.futures",
    title: "中金所股指期货持仓",
    source: "cffex",
    market: "a",
    compliance: "official",
    kind: "index",
    critical: false,
    unit: "手",
    traps: ["CSV 下载源，解析见 index-futures.ts:50"],
    fetcher: "index-futures.ts",
  },
  {
    id: "sina.sector",
    title: "新浪板块（接力/补涨用）",
    source: "sina",
    market: "a",
    compliance: "public-web",
    kind: "universe",
    critical: false,
    unit: "%",
    traps: ["与腾讯板块口径不同，两边不可混用，见 sectors.ts:96/227"],
    fetcher: "sectors.ts",
  },
];

const BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));

/** 按 id 查端点。查不到返回 undefined——调用方要自己决定降级，不要静默当 '可用'。 */
export function endpointOf(id: string): Endpoint | undefined {
  return BY_ID.get(id);
}

/** 按来源分组列出，用于页面「数据源」区块。 */
export function endpointsBySource(): Map<SourceId, Endpoint[]> {
  const out = new Map<SourceId, Endpoint[]>();
  for (const e of ENDPOINTS) {
    const list = out.get(e.source) ?? [];
    list.push(e);
    out.set(e.source, list);
  }
  return out;
}

/** 某个市场已登记的关键端点。 */
export function criticalOf(market: MarketId): Endpoint[] {
  return ENDPOINTS.filter((e) => e.market === market && e.critical);
}
