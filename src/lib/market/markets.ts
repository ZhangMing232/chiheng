/**
 * 这个文件是干什么的：
 * 多市场规则配置表（M1/M2，2026-10-12 拍板先美港）。美/港不是「特殊 A 股」——
 * T+0、无涨跌停、币种不同，这些差异先收进一张表，行情、页面、记账各自查表，
 * 不再散落 if (id.startsWith("hk"))。
 *
 * 你需要知道的：
 * - id 前缀即市场：sh/sz/bj → A 股，hk → 港股（hk00700），us → 美股（usAAPL）。
 *   六位/五位/字母代码的规则在 ID_PATTERN 里，server fn 的 validator 统一从这里取。
 * - settlement/limit/timezone 是**给下一步接策略管道用的登记**：本轮只把规则参数化
 *   （涨跌停返回 null、币种标签上屏），选股/记账/结算接美港是 REMAINING.md 里另记的一块。
 * - 纯函数零 I/O，可以被 registry（零副作用要求）和 server fn 同时引用。
 */

/** 市场标识。registry.ts 从这里取，不再自己定义。 */
export type MarketId = "a" | "hk" | "us";

export type MarketSpec = {
  id: MarketId;
  label: string;
  /** ISO 4217。Quote.price 的数量单位跟着它走。 */
  currency: "CNY" | "HKD" | "USD";
  /** 给人看的货币单位，价格后面跟着它（元 / 港元 / 美元）。 */
  currencyLabel: string;
  /** 卖出制度。记账循环从买入日下一根 K 线开始天然 T+1，接 T+0 市场要另开出口。 */
  settlement: "T+1" | "T+0";
  /**
   * 涨跌停行为：A 股按板块（model.ts:boardLimit 判 ST/科创/创业/北证）；
   * 美/港无涨跌停——limitTag 恒 null、exitFill 的跌停封死检查整段跳过。
   * 美股有大盘熔断（-7%/-13%/-20% 停市 15 分钟），那是全市场事件不是个股涨跌停，
   * 个股层面就是 none。
   */
  limit: "board" | "none";
  /** 交易所当地时区。session.ts 现在只算上海时间，接美/港交易时段时从这里取。 */
  timezone: string;
  /** 连续竞价头尾（当地分钟数）。港股 12:00-13:00 午休的细分留给交易时段接入。 */
  openMin: number;
  closeMin: number;
};

export const MARKETS: Record<MarketId, MarketSpec> = {
  a: {
    id: "a",
    label: "A股",
    currency: "CNY",
    currencyLabel: "元",
    settlement: "T+1",
    limit: "board",
    timezone: "Asia/Shanghai",
    openMin: 9 * 60 + 30,
    closeMin: 15 * 60,
  },
  hk: {
    id: "hk",
    label: "港股",
    currency: "HKD",
    currencyLabel: "港元",
    settlement: "T+0",
    limit: "none",
    timezone: "Asia/Hong_Kong",
    openMin: 9 * 60 + 30,
    closeMin: 16 * 60,
  },
  us: {
    id: "us",
    label: "美股",
    currency: "USD",
    currencyLabel: "美元",
    settlement: "T+0",
    limit: "none",
    timezone: "America/New_York",
    openMin: 9 * 60 + 30,
    closeMin: 16 * 60,
  },
};

/**
 * 内部 id 的合法形状，server fn 的 validator 统一从这里取：
 * A 股 sh/sz/bj + 六位数字；港股 hk + 五位数字（00700）；美股 us + 1–6 位字母代码
 * （AAPL / BRK-B 这种带横杠的也认）。
 */
export const ID_PATTERN = /^(?:(?:sh|sz|bj)\d{6}|hk\d{5}|us[A-Z][A-Z0-9.-]{0,5})$/;

/** id → 市场。认不出的前缀一律归 A 股（内部 id 都是带前缀的，不存在裸代码）。 */
export function marketOf(id: string): MarketId {
  if (id.startsWith("hk")) return "hk";
  if (id.startsWith("us")) return "us";
  return "a";
}

/** id → 市场配置。 */
export function marketSpecOf(id: string): MarketSpec {
  return MARKETS[marketOf(id)];
}

/** id → 货币标签（元 / 港元 / 美元），价格后面跟着它。 */
export function currencyLabelOf(id: string): string {
  return marketSpecOf(id).currencyLabel;
}
