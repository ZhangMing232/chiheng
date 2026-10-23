/**
 * 这个文件是干什么的：
 * 「资金流向」区的布局路由——现在挂在「每日复盘」下面（2026-10-23 用户要求：
 * 资金流向并入复盘，顶部导航少一格）。本文件只是 URL 层级（/review/flow/ 概览、
 * /review/flow/north 北向、/review/flow/industries 行业、/review/flow/sectors 板块、
 * /review/flow/stocks 个股、/review/flow/hot 游资、/review/flow/close 收盘快照、
 * /review/flow/margin 两融、/review/flow/futures 期指），各子页面各自保留自己的
 * loader 和 Frame；tab 条是 components/flow-sections.tsx 里的 FlowSectionTabs，
 * 9 个子页共用。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏只留「每日复盘」一个入口。
 * - 旧的 /flow 路由保留为重定向（routes/flow.tsx），书签不断。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/review/flow")({
  component: function FlowLayout() {
    return <Outlet />;
  },
});
