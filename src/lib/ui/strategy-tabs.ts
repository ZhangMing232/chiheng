/**
 * 策略区统一的子页 tab 条（六项）。
 *
 * 2026-11-05 用户拍板：策略竞技场并入策略看板——原来「研究」组下的 /arena 四页
 * （每日信号/策略管理/战绩跟踪/失败归因）搬进 /strategies 家族，和选股、追踪
 * 合成一个入口、一条 tab。
 * 2026-11-05 二次整理：四页统一 wide；「战绩跟踪」明细并进「跟单信号」页（同
 * 一份 tracking 数据的摘要与明细，没必要两个 tab），tab 六→五。旧地址 /arena/* 由 arena.$ splat 路由重定向，书签不断。
 *
 * 这份常量是唯一出处：五个页面（screener/positions/signals/manage/autopsy）
 * 都渲染同一条 tab，谁也不会漏更新。
 */
/**
 * 2026-11-12 二次收口（用户：页面太多，来回都是那几个内容）。
 *
 * 五个 tab 收成三个工作台：
 *   策略选股 ← 吸收「策略管理」（自己写策略/表达式只是选股的准备动作，不是第二件事）
 *   策略跟踪 ← 已经吸收「跟单信号」（11-11 做的）
 *   回测审计 ← 吸收「策略基因组」「失败归因」（都是"这套规则能不能信"的证据面）
 *
 * 被吸收的两块不删，改成工作台内的次级切换，页面少一层但能力不掉。
 */
export const SCREENER_SUB_TABS: { to: string; label: string }[] = [
  { to: "/strategies/screener", label: "现役选股" },
  { to: "/strategies/manage", label: "我的策略" },
];

/**
 * 「回测审计」工作台（/backtest、/strategies/genome、/strategies/autopsy 三页共用）。
 *
 * 2026-11-14 收编进「因子实验室」：侧栏「策略」组不再单列「回测审计」平级入口，
 * 它和因子发掘六页同属一个工作台。这里第一个 tab 是「因子实验室」本身，
 * 点它直接切回因子六页——「回测审计」在因子实验室里，而不是和它对等的两块。
 */
export const BACKTEST_SUB_TABS: { to: string; label: string }[] = [
  { to: "/factors", label: "因子实验室" },
  { to: "/backtest", label: "运行与比较" },
  { to: "/strategies/genome", label: "策略基因组" },
  { to: "/strategies/autopsy", label: "失败归因" },
];
