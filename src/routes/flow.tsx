/**
 * 这个文件是干什么的：
 * 「资金流向」区的布局路由。2026-10-21 用户要求：板块页并入资金流向，
 * 资金流向内部改子页面。本文件只是 URL 层级（/flow/ 资金流向、
 * /flow/sectors 板块），两个子页面各自保留自己的 loader 和 Frame；
 * tab 条在子页面内容顶部（SectionTabs）。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏只留一个「资金流向」入口。
 * - 旧的 /sectors 路由保留为重定向（routes/sectors.tsx），书签不断。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/flow")({
  component: function FlowLayout() {
    return <Outlet />;
  },
});
