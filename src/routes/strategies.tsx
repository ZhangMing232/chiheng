/**
 * 这个文件是干什么的：
 * 「策略」区的布局路由。2026-10-21 用户要求：策略选股 + 策略追踪合成一个页面，
 * 里面变子页面。本文件只是 URL 层级（/strategies/screener、/strategies/positions），
 * 两个子页面各自保留自己的 loader 和 Frame；tab 条在子页面内容顶部（SectionTabs）。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏只留一个「策略」入口。
 * - 旧的 /screener、/positions 路由保留为重定向（routes 下的同名文件），书签不断。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/strategies")({
  component: function StrategiesLayout() {
    return <Outlet />;
  },
});
