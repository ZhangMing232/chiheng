/**
 * 旧路由兼容。/ladder（连板天梯）2026-11-11 晚并进「盯盘」区（/watch/history）。
 * 本文件不再渲染页面，进来直接送过去。
 *
 * 为什么并：它和 /grid 读的是同一份三池快照、同一套板位分档、同一份涨停原因，
 * 只是画法一个格子一个表格。并完之后今天那一列的明细只留在 /watch/（今日梯队），
 * 这一页只负责「三天怎么变 + 晋级率」。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/ladder")({
  beforeLoad: () => {
    throw redirect({ to: "/watch/history", replace: true });
  },
});
