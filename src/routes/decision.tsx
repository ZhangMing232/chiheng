/**
 * /decision 已并入 /today（2026-11-12）。
 *
 * 为什么合并：市场温度、三路买入清单（前瞻 3 只 / 低估值 / 题材补涨）、监管异动、
 * 卖出纪律原来分散在 /、/decision、/huiyan、/watch 四个地方，每天要来回切。
 * 现在统一在 /today 一页从上到下走完：市场什么样 → 买什么 → 什么时候卖 → 盯什么。
 *
 * 这个路由只做 307，别再往里加内容——两页各写一份必然走形。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/decision")({
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
});
