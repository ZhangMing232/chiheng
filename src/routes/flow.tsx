/**
 * 这个文件是干什么的：
 * 「资金流向」区的布局路由。2026-11-11 从「每日复盘」下面拆回平级：
 * /flow/ 概览、/flow/north 北向、/flow/industries 行业、/flow/sectors 板块、
 * /flow/stocks 个股、/flow/close 收盘快照、/flow/margin 两融、
 * /flow/futures 期指。tab 条是 components/flow-sections.tsx 的 FlowSectionTabs。
 *
 * 为什么要拆回来（2026-10-23 并进去，2026-11-11 又拆出来，不是反复无常）：
 * 并进去之后 /review 底下挂了 9 个子页，其中资金流向自己还有 8 个二级页——
 * 从侧栏到具体一页要点三层，读者不知道自己在哪一层。资金流向本来就是
 * 「今天钱去哪了」的独立问题，和复盘的「今天盘面怎么样」不是一件事，
 * 拆回平级之后两边各自两个 tab，都不超过两层。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏在「盘后」组留一个入口。
 * - 旧的 /review/flow/* 保留为重定向（routes/review.flow.tsx、review.flow.$.tsx），
 *   2026-10-23 到 11-11 之间存下的书签不断链。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/flow")({
  component: function FlowLayout() {
    return <Outlet />;
  },
});
