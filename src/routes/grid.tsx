/**
 * 旧路由兼容。/grid（多股同屏）2026-11-11 晚并进「盯盘」区（/watch/）。
 * 本文件不再渲染页面，进来直接送过去。
 *
 * 为什么并：它和 /ladder 读的是同一份三池快照、同一套板位分档、同一份涨停原因，
 * 只是画法一个格子一个表格。用户原话「这俩玩意做的东西不是一样的吗，只有名字不一样」。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/grid")({
  beforeLoad: () => {
    throw redirect({ to: "/watch", replace: true });
  },
});
