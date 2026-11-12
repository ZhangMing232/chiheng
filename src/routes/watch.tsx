/**
 * 这个文件是干什么的：
 * 「盯盘」区的布局路由（2026-11-11 晚第二次整理：多股同屏 /grid + 连板天梯 /ladder
 * 合成一页）：/watch/ 今日梯队、/watch/history 三日演变。
 *
 * 为什么合（用户原话）：
 *   「你先改一下那个多股同屏和那个连板天梯变成一个盯盘就好了，这俩玩意你做的东西
 *    不是一样的吗，只有名字不一样」
 * 他说得对。两页读的是同一份三池快照，都按板位分档，都拿 getLimitUpReasons() 挂
 * 题材，只是画法一个用格子一个用表格。留着两个侧栏入口，等于让人在同一份数据里
 * 二选一。
 *
 * 合完之后各自只留别人没有的那部分（这是这次去重的规矩，不是把两页拼一起）：
 *   - 今日梯队：位置记忆（排好整天不重排）、封单额、开板次数、点格子弹涨停原因带出处。
 *   - 三日演变：昨天/前天两天的完整名单 + 今天的晋级率与家数（**今天不再重列票名**，
 *     票名和封单在今日梯队里已经有了，同一份数据摆两遍就是重复）。
 *
 * 你需要知道的：
 * - 壳不渲染东西，原样透出 Outlet；tab 条是 components/section-tabs.tsx 的 WATCH_TABS。
 * - 旧地址 /grid /ladder 全部保留为重定向（routes/grid.tsx、routes/ladder.tsx），书签不断链。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/watch")({
  component: function WatchLayout() {
    return <Outlet />;
  },
});
