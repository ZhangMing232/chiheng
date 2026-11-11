/**
 * 这个文件是干什么的：
 * 「题材」区的布局路由（2026-11-11 三个平级页合成一页）：/themes/intel 市场情报、
 * /themes/rotation 题材轮动、/themes/brief 题材简报。
 *
 * 为什么合：三页都在回答同一个问题的三段——「消息从哪来」（情报）→「钱在往哪个
 * 题材去」（轮动）→「这个题材里具体哪几只、为什么」（简报）。原来在侧栏里分属
 * 「资讯」和「盘后」两组，读的时候要来回跳；各自又都只有 100~200 行，撑不起
 * 一个平级入口。合成一页三段之后，一条链路走完不用换页。
 *
 * 你需要知道的：
 * - 壳不渲染东西，原样透出 Outlet；tab 条是 components/section-tabs.tsx 的 THEME_TABS，
 *   三个子页各自保留自己的 loader 和 URL（刷新、书签、分享都落在具体子页上）。
 * - 旧地址 /intel /rotation /brief 全部保留为重定向（routes/intel.tsx 等），书签不断链。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/themes")({
  component: function ThemesLayout() {
    return <Outlet />;
  },
});
