/**
 * 这个文件是干什么的：
 * 把「像 Vibe-Research 那样研究」和「像 Vibe-Trading 那样跑一轮」收成一张运行单。
 *
 * 你需要知道的：
 * 运行单只许指向赤轨已经接上的页面和数据。问券商下单、保证赚钱、没授权的选股，直接拒绝。
 * 这里不调用模型，也不发明数字。真要算，去它指出的那一页。
 */
import { screenAdvice } from "./red-line.ts";

export type DeskSide = "research" | "trading";

export type DeskHref =
  | "/"
  | "/review"
  | "/research"
  | "/debate"
  | "/reports"
  | "/calendar"
  | "/flow"
  | "/sectors"
  | "/overseas"
  | "/screener"
  | "/backtest"
  | "/factors"
  | "/positions";

export type DeskTool = {
  id: string;
  side: DeskSide;
  title: string;
  does: string;
  to: DeskHref;
  keys: string[];
};

export type DeskPlan = {
  question: string;
  tools: DeskTool[];
  refusals: string[];
  /** 问句里夹了买卖建议时，写明拦住了哪一条。没有就是 null。 */
  screened: string | null;
};

/** 已经接上的能力。keys 用来对上提问，不拿来生成结论。 */
export const DESK_TOOLS: DeskTool[] = [
  { id: "home", side: "research", title: "主控台", does: "看指数、今日信号和策略追踪，数字来自账本和行情。", to: "/", keys: ["大盘", "指数", "今天", "主控"] },
  { id: "review", side: "research", title: "每日复盘", does: "家数、涨跌停、资金和持仓对照。", to: "/review", keys: ["复盘", "涨跌家数", "情绪"] },
  { id: "research", side: "research", title: "个股研判", does: "一只票的证据、推断和缺口，分阶段写，不给买卖建议。", to: "/research", keys: ["研判", "基本面", "估值", "这只", "个股"] },
  { id: "debate", side: "research", title: "多空辩论", does: "同一只票的支持和反对，最后只留裁决点。", to: "/debate", keys: ["多空", "辩论", "看多", "看空"] },
  { id: "reports", side: "research", title: "研报库", does: "已导入的 PDF 或 Word，引用能回查原文。", to: "/reports", keys: ["研报", "pdf", "PDF"] },
  { id: "calendar", side: "research", title: "日历与事件", does: "持仓到期、业绩预告、增减持、回购、质押、申购。", to: "/calendar", keys: ["日历", "事件", "预告", "解禁", "回购"] },
  { id: "flow", side: "research", title: "资金流向", does: "大盘资金、北向披露和龙虎榜席位。没有的就写没有。", to: "/flow", keys: ["资金", "北向", "龙虎榜", "主力"] },
  { id: "sectors", side: "research", title: "板块", does: "东财行业的涨跌和资金。这不是景气度。", to: "/sectors", keys: ["板块", "行业"] },
  { id: "overseas", side: "research", title: "港美行情", does: "只看报价和 K 线，不进选股，也不进账。", to: "/overseas", keys: ["港股", "美股", "恒生", "纳指"] },
  { id: "screener", side: "trading", title: "策略选股", does: "六套写死的规则。现价打到买入价才记，不到券商。", to: "/screener", keys: ["选股", "策略", "买入价", "启动", "补涨"] },
  { id: "backtest", side: "trading", title: "回测", does: "无前视回测。要看超额和 t 值，前后半段翻号就不能用。", to: "/backtest", keys: ["回测", "超额", "胜率", "样本"] },
  { id: "factors", side: "trading", title: "因子发掘", does: "AI 只能提议因子。过不了预先登记的检验，不能进选股。", to: "/factors", keys: ["因子", "检验", "过拟合"] },
  { id: "positions", side: "trading", title: "策略追踪", does: "模拟账。打到卖出价或止损价才卖，买入当天不能卖。", to: "/positions", keys: ["持仓", "账", "止损", "模拟"] },
];

const REFUSALS: { keys: string[]; why: string }[] = [
  { keys: ["下单", "券商", "实盘", "富途", "盈透", "自动交易"], why: "不到券商。买卖只记在本机模拟账里。" },
  { keys: ["稳赚", "保证赚", "一定赚", "包赚"], why: "不保证收益。回测 t 值不到 2，或者前后半段翻号，就当没测出来。" },
  { keys: ["问财", "同花顺选股"], why: "问财没有授权，不爬，也不假装能自然语言选全市场。" },
  { keys: ["印度", "韩国", "越南", "加密", "比特币"], why: "这些市场不做。港股和美股只看行情，策略账仍是 A 股。" },
];

function hit(question: string, keys: string[]): boolean {
  const q = question.toLowerCase();
  return keys.some((key) => q.includes(key.toLowerCase()));
}

/** 把一句提问拆成：该打开哪些现成工具，以及哪些要求直接拒绝。 */
export function planDesk(question: string): DeskPlan {
  const text = question.trim();
  const tools = text ? DESK_TOOLS.filter((tool) => hit(text, tool.keys)) : [];
  const refusals = text ? REFUSALS.filter((item) => hit(text, item.keys)).map((item) => item.why) : [];
  const screened = screenAdvice(text);
  return {
    question: text,
    tools,
    refusals,
    screened: screened.ok ? null : screened.hits.join("；"),
  };
}
