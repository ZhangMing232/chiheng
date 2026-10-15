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

import type { MarketId } from "@/lib/market/markets";

/** 数据源。 */
export type SourceId = "tencent" | "sina" | "eastmoney" | "cninfo" | "tushare" | "akshare" | "bse" | "cffex" | "baostock" | "tdx" | "chinabond" | "nbs" | "pboc";

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
  | "calendar"
  | "risk";

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
  tdx: "通达信官网",
  chinabond: "中债（中央结算公司）",
  nbs: "国家统计局",
  pboc: "中国人民银行",
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
      "**2026-10-12 实测跑通过一次**（7 报告期 11636 只），但**现在不可重跑**：akshare 依赖 py_mini_racer（只有源码包要编译，本环境装不了 sdist）；曾放占位模块假装能 import，已撤。要恢复须换 Python ≤3.12 装真 py_mini_racer。已落盘的 data/backtest/fundamentals.json 读取不受影响，见 scripts/fetch-fundamentals.py 头部说明",
      "`debt`（资产负债率）**恒为 null**：东财这个接口不给这个字段。要用它得切回 tushare 版（要 2000 积分）",
      "roe/dtYoy/gm/debt 口径见 fundamentals.ts:15-17，与 tushare 的净利润同比口径不同（factors.ts:185-186 有对照说明）",
      "**必须用隔离环境的 python 跑**（系统 python3 没有 akshare，会 ModuleNotFoundError），路径 /Users/zhangweimin/.workbuddy/binaries/python/envs/default/bin/python，见 scripts/fetch-fundamentals.py 用法段",
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

  {
    id: "eastmoney.consensus",
    title: "东财机构预测（一致预期 EPS / 机构数 / 前瞻 CAGR / 分歧）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "fundamental",
    critical: false,
    unit: "元（EPS）/ 倍（PE）/ %（CAGR）",
    traps: [
      "**2026-10-12 实测通过**（600519，50 条研报 → 16 家机构，一致预期 EPS 68.59）。走 reportapi.eastmoney.com 直连，**不依赖 akshare**（akshare 的 py-mini-racer 在 arm64 装不上，见GAP-REPORT.md 数据源正路）",
      "接口返回的是**研报列表**，不是现成的一致预期——要 consensus.ts:aggregateConsensus 聚合（同机构取最新、算均值、max/min 分歧）。单看一份研报的 EPS 会当成那家机构的预测，见 consensus.ts 头注释",
      "EPS 字段是**字符串**（\"71.3200000000\"），要转 number，转不了留 null 而不是 0，见 consensus-store.ts:num",
      "pageSize 上限 50，hits 可能更多（茅台 126 条）。50 条已覆盖 16 家机构足够聚合，但要留意大票可能截断，见 consensus-store.ts:fetchConsensusReports",
    ],
    fetcher: "src/lib/market/consensus-store.ts:fetchConsensusReports → consensus.ts:aggregateConsensus",
  },

  {
    id: "baostock.financials",
    title: "证券宝三表 + 杜邦（利润/资产/现金流 + dupont）",
    source: "baostock",
    market: "a",
    compliance: "public-web",
    kind: "fundamental",
    critical: false,
    unit: "元 / 比率（比率字段是小数，如 debt=0.1519 是 15.19%）",
    traps: [
      "**2026-10-12 实测通过**（600519，6 个报告期，PIT 守住）。选它替代 akshare 三表：akshare 依赖 py_mini_racer，其 macOS wheel 只有 x86_64、本机 arm64 装不上；baostock 纯 wheel 零鉴权。见 scripts/fetch-three-sheets.py",
      "**代码格式带点**：baostock 要 `sh.600519` 不是 `sh600519`，传错报「股票代码应为9位」而不是返回空，见 scripts/fetch-three-sheets.py:bs_code",
      "**补上东财给不了的两个字段**：`debt`（liabilityToAsset，东财业绩报表恒 null）和 `cfoToNp`（经营现金流/净利润，财报拆解「利润质量」检查的原料）",
      "PIT 命脉：只收 pubDate 非空的行，没公告日期宁可丢，见 scripts/fetch-three-sheets.py:fetch",
      "**不支持北交所**（同 valuation 端点，索要 bj 代码是报错不是返回空）；免费接口有速率限制，全市场批量每 50 只 sleep 0.5 秒，见 scripts/fetch-three-sheets.py:main",
    ],
    fetcher: "scripts/fetch-three-sheets.py → data/backtest/financials.json",
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
    id: "eastmoney.margin",
    title: "东财融资融券明细",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "risk",
    critical: false,
    unit: "元",
    traps: [
      "T+1 发布：2026-10-12（周一）跑 fetch-margin.ts 拿到的最新交易日是 2026-10-09——周末不算，盘中跑也是昨天",
      "RZYEZB（占流通市值比）部分记录为 null——缺的样子就是缺，页面显示「—」不拿 0 凑",
      "单源无备份：RPTA_WEB_RZRQ_GGMX 一个端点，挂了 getMargin 带 why 降级",
    ],
    fetcher: "margin.ts + scripts/fetch-margin.ts（落盘 data/risk/margin-latest.json）",
  },
  {
    id: "eastmoney.holder",
    title: "东财股东户数（筹码集中度）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "risk",
    critical: false,
    unit: "户（HOLDER_NUM）/ %（HOLDER_NUM_RATIO 环比）",
    traps: [
      "**2026-10-12 实测通过**（600519 浦发：2026-06-30 163327 户 / +8.1%，RPT_HOLDERNUM_DET），见 holder-lift.ts:fetchHolders",
      "**季度披露，一年约 4 个点**：不是日频数据——页面要标披露期；新股/部分票没有记录，见 holder-lift.ts 头注释",
      "HOLDER_NUM_RATIO 是较上期变化百分比（8.1 = 户数环比 +8.1%）——正 = 筹码发散、负 = 集中，见 holder-lift.ts 头注释",
      "排序用 sortColumns=END_DATE&sortTypes=-1（最新在前），缓存 1 小时——见 holder-lift.ts:fetchHolders",
    ],
    fetcher: "holder-lift.ts:fetchHolders → quotes.functions.ts:getHolders",
  },
  {
    id: "eastmoney.lift",
    title: "东财限售解禁表（抛压日历）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "risk",
    critical: false,
    unit: "万股（FREE_SHARES）/ 万元（LIFT_MARKET_CAP）/ 小数（FREE_RATIO）",
    traps: [
      "**2026-10-12 实测通过**（600519/688041/001270 等，RPT_LIFT_STAGE）——见 holder-lift.ts:fetchLifts",
      "**解禁日字段叫 FREE_DATE，不叫 LIFT_DATE**——columns 写错东财直接报 9501 而不是返回空，踩过",
      "FREE_SHARES 是万股、LIFT_MARKET_CAP 是万元、FREE_RATIO 是小数（0.102 = 10.2%，页面展示 ×100）",
      "接口含历史解禁——调用方要自己筛未来窗口（upcomingLifts 默认 90 天）；近期没解禁的票返回 0 条是正常不是故障",
    ],
    fetcher: "holder-lift.ts:fetchLifts/upcomingLifts → quotes.functions.ts:getLifts",
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
    id: "eastmoney.hk",
    title: "东财港股行情（报价 + 日 K）",
    source: "eastmoney",
    market: "hk",
    compliance: "public-web",
    kind: "kline",
    critical: false,
    unit: "港元",
    traps: [
      "**2026-10-12 实测通过**（hk00700 腾讯控股 425.800 港元）——见 providers/overseas.ts:fetchOverseasQuote",
      "**行情域和 A 股分开**：secid=116.XXXXX（港股），A 股的腾讯/东财域里没有港美股，见 oversea​s.ts:secidOf",
      "K 线七段是「日期,开,收,高,低,量,额」——**开收在高前**，和腾讯 qfqday 顺序不同，别照搬，见 oversea​s.ts:parseKlineRow",
      "报价走 kline lmt=1 顺带拿（最新 K 线 + preKPrice 昨收 + name），不碰 stock/get 的 f43——那个要 ÷1000 且随票变",
      "REMAINING 写「数据源可用 yahoo」，实测本机 query1.finance.yahoo.com 返回运营商 block 页（HTML）——所以接东财，yahoo 留作备用路线",
    ],
    fetcher: "providers/overseas.ts → quotes.functions.ts:getOverseasQuote/getKline",
  },
  {
    id: "eastmoney.us",
    title: "东财美股行情（报价 + 日 K）",
    source: "eastmoney",
    market: "us",
    compliance: "public-web",
    kind: "kline",
    critical: false,
    unit: "美元",
    traps: [
      "**2026-10-12 实测通过**（usAAPL 苹果 340.935 美元）——见 providers/overseas.ts:fetchOverseasQuote",
      "secid=105.SYMBOL（美股）；联想接口正股 SecurityType=20（Apple Notes 债券是 7），别收进搜索，见 oversea​s.ts:parseSuggest",
      "美股分冬夏令时（America/New_York  offset -5/-4）——markets.ts 只登记了时区，交易时段接入时要处理",
    ],
    fetcher: "providers/overseas.ts → quotes.functions.ts:getOverseasQuote/getKline",
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
    id: "tdx.daily",
    title: "通达信盘后包（全市场日线截面）",
    source: "tdx",
    market: "a",
    compliance: "official",
    kind: "kline",
    critical: false,
    unit: "元/股",
    traps: [
      "**2026-10-14 接入并实测**：一个请求拿沪深北全市场当日日线（20261013 实测 5565 只 A 股股票，2.7MB zip），见 scripts/fetch-tdx-package.py",
      "**它是日线源，不是腾讯快照的替代品**：一天一个包，盘中不更新——腾讯快照盘中 5 分钟一拉，盘后包一天一个，两者的更新节奏不同",
      "**当天的包 404 是正常的**：2026-10-14 实测 20261014 的包 404、20261013 有（收盘后数小时才发布）。报错必须写「还没发布」而不是「接口挂了」——不同含义，否则会白排查",
      "**成交量单位是股**（腾讯的 K 线是科创板股、其余手——两个口径不同）。混用前先换算，不然差 100 倍；实测 600519 成交量 2657276 股 = 2.66 万手",
      "**包里 52168 条只有 5565 条是 A 股股票**（2026-10-13 实测）：其余是指数（沪 000xxx/深 399xxx/北 899xxx/999xxx）、ETF 与 LOF（沪 5xxxxx/深 15xxxx）、可转债与债券、B 股、通达自编（88xxxx）。用白名单按市场过滤，见 scripts/fetch-tdx-package.py 的 STOCK_PREFIX",
      "**同一个代码段在不同市场含义不同**：沪市 000001 是上证指数，深市 000001 是平安银行。所以过滤必须是 (market, prefix) 组合，不能只看 prefix——第一版按黑名单写全漏了",
      "5565 只 vs 腾讯快照 5224 只**对不齐**（差 341 只，两个口径不同，可能来自 ST 与停牌股处理差异）。这个截面不能直接当 universe 用",
      "二进制布局：.cod 150 字节/条（代码 0:6、序号 32:34、名称 40:72 GBK）+ .md1 512 字节/块（昨收 4:12、开高低收 12:44、成交量 56:64、成交额 72:80，小端）。协议来自 a-stock-data SKILL V3.9.0 §1.3（参考 jing2uo/tdx2db，MIT），见 scripts/fetch-tdx-package.py:_parse_market",
    ],
    fetcher: "scripts/fetch-tdx-package.py → data/backtest/tdx-daily/{ymd}.json",
  },
  {
    id: "eastmoney.limitup",
    title: "东财涨停/炸板/跌停三池（信号层）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "risk",
    critical: false,
    unit: "元",
    traps: [
      "**2026-10-14 接入并实测**：当天涨停 36 / 炸板 24 / 跌停 11 只（东财 push2ex），见 limit-up.functions.ts:getSignals",
      "**价格是 ×1000 的整数**（p: 6300 = 6.30 元）——a-stock-data 文档说的「已 ÷1000」是它的封装做的，原始值没有",
      "**炸板池涨跌幅是负的**（涨停后开板回落）——和涨停池的口径不同，页面必须显示回落多少，不能显示成「涨停」",
      "**连板数 lbc 在炸板/跌停池是 null**——那两个池不排连板，和涨停池不同，显示「—」不是 0",
      "**zttj（N天M板）可能整个缺失**（跌停池实测是 {}），和涨停池不同，解析容忍，不编「0天0板」",
      "**date 必须传交易日**，非交易日东财 data 返回 null（和交易日不同）→ 页面说「这天不是交易日」，不显示全 0",
      "盘中拉到的涨停池是半截（收盘后才定），和收盘后的口径不同，页面按 15:00 标「已定/未定」",
      "接口来自 a-stock-data SKILL V3.10.2 §8.1（push2ex 四池）；**同花顺涨停揭秘没接**——那是市场叙事不是核验过的因果",
    ],
    fetcher: "limit-up.functions.ts:getSignals → push2ex.eastmoney.com getTopicZTPool/ZBPool/DTPool",
  },
  {
    id: "chinabond.yield",
    title: "中债国债收益率曲线（宏观水温）",
    source: "chinabond",
    market: "a",
    compliance: "official",
    kind: "index",
    critical: false,
    unit: "%",
    traps: [
      "**2026-10-15 接入并实测**：一次查 30 天返回 18 个交易日 × 8 档期限，10-14 的 10 年期 1.6516%，见 macro.functions.ts:getMacro",
      "**单位是 %**（1.6516 = 1.6516%），不是小数——除 100 就成了 0.0166%",
      "**官网单次查询超过 1 年会静默返回 0 行**（不是报错，是空表——比报错更难发现），所以窗口固定 180 天，见 macro.functions.ts 的 WINDOW_DAYS",
      "**它不公布债券市场交易日历也没有总条数**，所以「某天没数据」分不清是节假日还是接口坏了——和能判定的源不同，只报「数据截至哪天」，不当异常",
      "**中短期票据曲线没有 30 年那一档**（和国债曲线的档位不齐），解析给 null 不给 0",
      "接口来自 a-stock-data SKILL V3.10.2 §11.3（中央结算公司官方，零鉴权），走 HTML 表格解析，见 macro.ts:parseYieldCurve",
    ],
    fetcher: "macro.functions.ts:getMacro → yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery",
  },
  {
    id: "pboc.socialfinancing",
    title: "人民银行社会融资规模增量（社融）",
    source: "pboc",
    market: "a",
    compliance: "official",
    kind: "index",
    critical: false,
    unit: "亿元人民币",
    traps: [
      "**2026-10-15 接入并实测**：2022-01 ~ 2026-09 共 57 个月；2026-09 社融增量 35476 亿（贷款 12734 · 政府债 15362 · 企业债 -393），见 scripts/fetch-social-financing.py",
      "**xlsx 是纯标准库手写解析的（零新增依赖）**：akshare 就是因为 arm64 装不上 py-mini-racer 而废掉的，社融不能再踩一次。xlsx 就是 zip + XML，zipfile + re 够用——和通达信盘后包那套一样，见 fetch-social-financing.py:parse_xlsx",
      "**Excel 会把 `2026.10` 的尾零吃掉读成 `2026.1`**，和 1 月的 `2026.01` 撞车——1 月在表里始终两位，所以一位的那位判为 10 月，见 month_label()",
      "**sheet 名不能写死 sheet1.xml**：2021 年那份就不是 sheet1（实测）；而且它是 .xls 旧二进制格式不是 zip，脚本读不了——会明说并记进 failed 数组，不静默跳过，见 parse_xlsx",
      "**未来的月份有行但数值全空**（10 月、11 月已列出还没发布），要剔掉——否则 null 会被当成「社融为 0」",
      "**只支持 2021 年起**：2020 及更早是旧版式（表头与项目名合并在同一单元格、附表还带「2017 年以来的历史区」），和这套解析不兼容——脚本见 FIRST_SUPPORTED_YEAR 直接抛错，硬凑会出错",
      "链路是三级跳（索引 → 年份页 → 专题页 → xlsx），每级结构变了都抛错，**不静默返回空表**——空表比报错难发现得多（skill 文档里标的 fail-fast 原则）",
    ],
    fetcher: "scripts/fetch-social-financing.py → data/macro/social-financing.json → macro.functions.ts:getSocialFinancing",
  },
  {
    id: "nbs.pmi",
    title: "国家统计局 PMI（制造业/非制造业/综合）",
    source: "nbs",
    market: "a",
    compliance: "official",
    kind: "index",
    critical: false,
    unit: "%",
    traps: [
      "**2026-10-15 接入并实测**：2026年9月制造业 50.1 / 非制造业 50.2 / 综合 50.7，见 macro.functions.ts:getPmi",
      "**registry 里另一条「统计局被 WAF 403 挡」说的是 akshare 的分行业接口**，**统计局官网本身是通的**——首页和最新发布页都能取。别被那条旧记录误导",
      "**正文是全角括号而且括号里有空格**（`（ PMI ）为 50.1%`），必须把空白**整个删掉**再匹配——只压成单个空格的话一条都匹配不到（实测，和 skill 文档标的🔴 坑一致）",
      "**大中小企业的措辞统计局改过**（三种版式，全合并/中小合并/全拆），解析要逐层回退；认不出给 null 不猜，主体三个 PMI 才是必须项",
      "月频、月末发布，比财报早一个季度反映景气——和国债收益率的日频不同，别当日频信号用",
    ],
    fetcher: "macro.functions.ts:getPmi → stats.gov.cn/sj/zxfb/ 找「采购经理指数」条目",
  },
  {
    id: "eastmoney.lpr",
    title: "LPR 贷款市场报价利率（东财数据中心）",
    source: "eastmoney",
    market: "a",
    compliance: "public-web",
    kind: "index",
    critical: false,
    unit: "%",
    traps: [
      "**2026-10-15 接入并实测**：2026-09-20 报价 1Y 3.0 / 5Y 3.5，见 macro.functions.ts:getLpr",
      "**东财分页从第 1 页起，所以 sortTypes 必须 -1（降序）**：给升序的话拿到的是最早的 200 条（2013-10~2014-06，实测页面显示 2014-06-24 / 5.76%），而快照取最后一条。这个 bug 只有实测能发现——测试用的是自己造的数据，测不出东财怎么分页",
      "**同一张报表里混着旧贷款基准利率**（1991-04 ~ 2015-10，38 行，LPR1Y 字段为空）。不剔掉的话历史图上会多出一段 5% 以上的「贷款利率」——它和 LPR 是不同的东西",
      "2019-08-20 改革后每月 20 日报价；5 年期品种在那之前不存在（给 null 不是 0）",
      "限速走 fetch-policy 的 eastmoney：1300ms 串行，与资金流/行业那些端点同一风控面——开并发会立刻 403，串行跑 300 只全程无问题（2026-10 实测）",
    ],
    fetcher: "macro.functions.ts:getLpr → datacenter-web.eastmoney.com RPTA_WEB_RATE",
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
