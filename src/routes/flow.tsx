/**
 * 这个文件是干什么的：
 * 「资金流向」区的布局路由。2026-10-21 用户要求：板块页并入资金流向，且资金流向
 * 一页内的滚动锚点（走势/大盘资金/北向/行业/个股/游资/收盘快照/两融/期指）全部
 * 改成真实子页面，不再无限下滑。本文件只是 URL 层级（/flow/ 概览、/flow/trend
 * 走势、/flow/market 大盘资金、/flow/north 北向、/flow/industries 行业、
 * /flow/sectors 板块、/flow/stocks 个股、/flow/hot 游资、/flow/close 收盘快照、
 * /flow/margin 两融、/flow/futures 期指），各子页面各自保留自己的 loader 和
 * Frame；tab 条是 components/flow-sections.tsx 里的 FlowSectionTabs，11 个子页共用。
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
