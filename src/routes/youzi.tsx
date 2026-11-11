/**
 * 这个文件是干什么的：
 * 「游资与席位」区的布局路由（2026-11-11 由两个平级页合并）：/youzi/track 游资追踪、
 * /youzi/seats 席位档案。
 *
 * 为什么合：两页问的是同一件事的两头——「今天谁在买」（追踪）和「跟着这些席位买
 * 到后来赚不赚」（档案）。分开摆的时候，读者看完席位名想去查战绩得跳一次页面，
 * 而两边用的是同一份龙虎榜数据。合并后一段链路读完。
 *
 * 你需要知道的：
 * - 壳不渲染东西，原样透出 Outlet；tab 条是 YOUZI_TABS。
 * - 旧地址 /hotmoney /seats 保留为重定向（routes/hotmoney.tsx、routes/seats.tsx）。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/youzi")({
  component: function YouziLayout() {
    return <Outlet />;
  },
});
