/**
 * 这个文件是干什么的：
 * 「研究」区的布局路由。2026-10-26 用户要求：个股研判 / 多空辩论 / 研报库 / 笔记
 * 四个平级页合成一个「研究」页，里面用二级 tab 切换（SectionTabs，和复盘区同模式）。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；四个子页各自保留自己的 loader 和 Frame。
 * - 旧的 /debate /reports /notes 保留为重定向文件（routes/debate.tsx 等），书签不断。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/research")({
  component: function ResearchLayout() {
    return <Outlet />;
  },
});
