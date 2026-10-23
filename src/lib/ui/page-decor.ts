/**
 * 这个文件是干什么的：
 * **每个功能页面的装饰配置表**。一处定义，全站生效。
 *
 * 你需要知道的：
 * - 装饰分三层：L1 底纹（功能组色相氛围）、L2 页头（身份 + 状态）、L3 专属件（个性）。
 * - **L1 按「功能组」定，不按页面定**——同一组的页面底纹相同，一眼知道自己在哪一组。
 * - **L2 的 `status` 是动态的**：从页面 loader 的真实数据算出来（比如今日复盘做完了没）。
 *   没数据就显示 null，页头少一块，不编。
 * - **L3 只给真正有得说的页面**（资金流向的箭头群、因子发掘的六关徽章、
 *   多空辩论的对峙）。不是每页都硬凑一个装饰件。
 *
 * 为什么要这个表：29 个页面原本长得一模一样（全是 Panel 堆叠），
 * 装饰如果散在各个页面文件里，改一次要动 29 个地方。做成表就一处。
 *
 * 口径纪律（同全站）：装饰**不许编数据**。status 的数字必须来自真实 loader；
 * 编不出来就写 null，页头就少一个 pill。
 */

import {
  Bell,
  BrainCircuit,
  Coins,
  CreditCard,
  FileSearch,
  FileText,
  FlaskConical,
  Gauge,
  Globe,
  History,
  Image,
  LayoutDashboard,
  LineChart,
  ListFilter,
  LogIn,
  type LucideIcon,
  Newspaper,
  NotebookPen,
  Scale,
  ScanSearch,
  Settings,
  Sparkles,
  Star,
  Table,
  Users,
} from "lucide-react";

/** L1 底纹色相：按功能组定。一个组一个色相，同组页面底纹一致。 */
export type DecorHue = "brand" | "blue" | "amber" | "green" | "violet";

/** 状态药丸的语义色。涨跌色不能占用（那是行情的），所以只有中性/状态色。 */
export type StatusTone = "neutral" | "ok" | "warn" | "brand";

export type PageStatus = {
  /** 药丸上的小字（如"今日复盘"） */
  label: string;
  /** 药丸上的值（如"已完成"）。null 表示这一格不显示。 */
  value: string | null;
  tone?: StatusTone;
};

export type PageDecor = {
  /** 页面显示名（页头标题）。**这是页头的权威来源**——不依赖侧栏导航表，
   *  因为有几个页面没有侧栏入口（/ai、/symbol、/membership、/strategies/positions），
   *  靠 navHit 取标题会拿到空字符串，页头就成了空壳。 */
  title: string;
  /** 页面图标（页头左侧） */
  icon: LucideIcon;
  /** 一句话职能——回答"这页是干啥的"。写给用户看，不是写给开发者看。 */
  purpose: string;
  /** L1 底纹色相 */
  hue: DecorHue;
  /** L2 页头的状态药丸。由页面通过 Frame 的 status prop 传进来 */
  status?: PageStatus | null;
  /** L3 专属装饰件的种类。不给就没有——不硬凑。 */
  ornament?: OrnamentKind;
};

/** L3 专属装饰件。每种对应一个页面的核心概念。 */
export type OrnamentKind =
  | "flow-arrows"
  | "gate-badges"
  | "evidence-chain"
  | "debate-split"
  | "ladder-rungs"
  | "style-preview"
  | "trend-spark"
  | "pulse-wave"
  /** 复盘：一天的涨跌节奏（收/盘前/盘后三个时段） */
  | "day-rhythm"
  /** 持仓：冠军-挑战者的对决（谁在领跑） */
  | "champion-race"
  /** 个股页：这只票现在的价与位置 */
  | "quote-tape"
  /** 提醒：一条条待办的时间线 */
  | "alert-timeline"
  /** 会员/登录：档位阶梯 */
  | "tier-ladder";

/**
 * 路径 → 装饰配置。
 *
 * 键是路由 path。子页面（/flow/stocks、/review/signals）没有单独配置，
 * 靠 `decorFor` 的前缀匹配继承父页面——它们本来就是同一个功能区。
 */
export const PAGE_DECOR: Record<string, PageDecor> = {
  "/": {
    title: "主控台",
    icon: LayoutDashboard,
    purpose: "今天的账、信号和钱，一屏看完",
    hue: "brand",
    ornament: "pulse-wave",
  },
  "/butler": {
    title: "大管家",
    icon: Sparkles,
    purpose: "问它，它先读一遍项目现状再答",
    hue: "brand",
  },
  "/studio": {
    title: "自媒体图文",
    icon: Image,
    purpose: "把今天的数据做成能发的图和文",
    hue: "brand",
    ornament: "style-preview",
  },

  "/overview": {
    title: "股市总览",
    icon: Gauge,
    purpose: "全市场一张快照：指数、广度、资金",
    hue: "blue",
    ornament: "trend-spark",
  },
  "/review": {
    title: "每日复盘",
    icon: History,
        ornament: "day-rhythm",
    purpose: "收盘后把今天理一遍：盘面 · 资金 · 事件",
    hue: "blue",
  },
  // 2026-10-23 资金流向并入复盘后，路由从 /flow/* 变成 /review/flow/*。
  // **配置表的键必须跟着路由走**：不改的话 decorFor 的前缀匹配会把这些页
  // 全部判给 /review——标题显示「每日复盘」、专属件变成「今天节奏」，
  // 而侧栏 aside 还写着「资金流向 · 个股」，两处对不上（实测踩到）。
  "/review/flow": {
    title: "资金流向",
    icon: Coins,
    purpose: "钱往哪去：个股、板块、游资三条线",
    hue: "blue",
    ornament: "flow-arrows",
  },
  "/news": {
    title: "快讯",
    icon: Newspaper,
    purpose: "7x24 电报，利好利空分开摆",
    hue: "blue",
    ornament: "pulse-wave",
  },
  "/overseas": {
    title: "港美行情",
    icon: Globe,
        ornament: "day-rhythm",
    purpose: "港股美股，A股之外的另一个盘",
    hue: "blue",
  },

  "/strategies/screener": {
    title: "策略",
    icon: ListFilter,
        ornament: "gate-badges",
    purpose: "按规则筛出候选股，只给名单不给结论",
    hue: "violet",
  },
  "/strategies/positions": {
    title: "策略追踪",
    icon: Table,
        ornament: "champion-race",
    purpose: "在跟的仓位、当日盈亏、谁在领跑",
    hue: "violet",
  },
  "/factors": {
    title: "因子发掘",
    icon: FlaskConical,
    purpose: "挖因子：六关判决，过不了就淘汰",
    hue: "violet",
    ornament: "gate-badges",
  },
  "/backtest": {
    title: "回测",
    icon: LineChart,
    purpose: "拿历史数据跑一遍，看能不能活",
    hue: "violet",
    ornament: "trend-spark",
  },

  "/research": {
    title: "个股研判",
    icon: FileSearch,
    purpose: "六阶段跑证据，出一份能回查的研判",
    hue: "amber",
    ornament: "evidence-chain",
  },
  "/debate": {
    title: "多空辩论",
    icon: Scale,
    purpose: "多空各找证据，谁的论据硬听谁的",
    hue: "amber",
    ornament: "debate-split",
  },
  "/reports": {
    title: "研报库",
    icon: FileText,
        ornament: "evidence-chain",
    purpose: "存下来的研判，可以并排比",
    hue: "amber",
  },
  "/notes": {
    title: "笔记",
    icon: NotebookPen,
        ornament: "evidence-chain",
    purpose: "自己的判断，随手记下来",
    hue: "amber",
  },

  "/my-stocks": {
    title: "自选与持仓",
    icon: Star,
        ornament: "quote-tape",
    purpose: "自选和持仓，都在这儿",
    hue: "green",
  },
  "/inbox": {
    title: "提醒",
    icon: Bell,
        ornament: "alert-timeline",
    purpose: "该看没看的提醒，都堆在这",
    hue: "green",
  },
  "/settings": {
    title: "设置与状态",
    icon: Settings,
        ornament: "gate-badges",
    purpose: "数据源、记账、显示偏好",
    hue: "green",
  },
  "/admin": {
    title: "管理系统",
    icon: Users,
        ornament: "tier-ladder",
    purpose: "用户和档位，站长自己看",
    hue: "green",
  },

  "/ai": {
    title: "AI 管理",
    icon: BrainCircuit,
    purpose: "AI 只能提议，判决永远归预注册函数",
    hue: "violet",
    ornament: "gate-badges",
  },
  "/symbol": {
    title: "个股",
    icon: ScanSearch,
        ornament: "quote-tape",
    purpose: "单只票的全部：行情、研判、持仓",
    hue: "blue",
  },
  "/login": {
    title: "登录",
    icon: LogIn,
    purpose: "登录赤轨",
    hue: "brand",
  },
  "/membership": {
    title: "会员",
    icon: CreditCard,
        ornament: "tier-ladder",
    purpose: "档位、定价、怎么开通",
    hue: "brand",
  },
};

/**
 * 按路径找装饰配置。
 *
 * 精确匹配优先；匹配不到就按前缀找父页面（/flow/stocks → /flow）。
 * 都没有返回 null——装饰是加分项，不该让任何页面因为缺配置就崩。
 */
export function decorFor(path: string): PageDecor | null {
  const direct = PAGE_DECOR[path];
  if (direct) return direct;
  // 前缀匹配：取最长的匹配项（/strategies/screener 比 /strategies 更具体）
  let best: { key: string; decor: PageDecor } | null = null;
  for (const [key, decor] of Object.entries(PAGE_DECOR)) {
    if (key === "/") continue; // "/" 是所有路径的前缀，不能参与前缀匹配
    if (path === key || path.startsWith(key + "/")) {
      if (!best || key.length > best.key.length) best = { key, decor };
    }
  }
  return best?.decor ?? null;
}

/** L1 底纹色相 → 具体色值。深浅两套（跟随 data-theme）。 */
export const HUE_COLORS: Record<DecorHue, { dark: string; light: string }> = {
  brand: { dark: "#e63c4f", light: "#c62016" },
  blue: { dark: "#3d8bff", light: "#1f6fd0" },
  amber: { dark: "#c9a869", light: "#8a6a1f" },
  green: { dark: "#0bb97b", light: "#0b7040" },
  violet: { dark: "#8b7bd8", light: "#5c4bb0" },
};
