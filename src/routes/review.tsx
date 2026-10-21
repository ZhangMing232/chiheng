/**
 * 这个文件是干什么的：
 * 「复盘」区的布局路由。2026-10-21 用户要求：每日复盘 + 信号合成一个页面，
 * 里面变子页面。本文件只是 URL 层级（/review/ 复盘、/review/signals 信号），
 * 两个子页面各自保留自己的 loader 和 Frame；tab 条在子页面内容顶部（SectionTabs）。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏只留一个「每日复盘」入口。
 * - 旧的 /signals 路由保留为重定向（routes/signals.tsx），书签不断。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/review")({
  component: function ReviewLayout() {
    return <Outlet />;
  },
});
