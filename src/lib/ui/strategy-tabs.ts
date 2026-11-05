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
export const STRATEGY_TABS: { to: string; label: string }[] = [
  { to: "/strategies/screener", label: "策略选股" },
  { to: "/strategies/positions", label: "策略追踪" },
  { to: "/strategies/signals", label: "跟单信号" },
  { to: "/strategies/manage", label: "策略管理" },
  { to: "/strategies/autopsy", label: "失败归因" },
];
