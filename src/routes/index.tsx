/**
 * 首页已并入 /today（2026-11-12）。
 *
 * 为什么并：总览和今日决策原来各有一份「涨停/连板/最高板/炸板率」指标条，
 * 各有一份梯队和资金摘要——同一批数据摆两遍，用户每天要来回切才知道哪份是新的。
 * 现在打开站点直接进 /today：一屏从上到下走完
 *   指标条 → 前瞻 3 只 → 短线买什么 → 中长线买什么 → 主力资金 → 监管异动 → 什么时候卖
 *
 * 总览原来独有的「当日主线龙头卡 / 主线强度条 / 个股榜 / 状态条」没有再搬进来：
 * 题材强弱看 /themes，个股看详情抽屉，状态看顶栏状态条——不在这里做第三份。
 *
 * 这个路由只做 307，别再往里加内容。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
});
