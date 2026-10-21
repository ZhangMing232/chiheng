/**
 * 这个文件是干什么的：
 * 旧路由兼容。2026-10-21 日历页撤销：「持仓到期」整个删掉（计划卖出日在
 * 策略追踪页每笔都标着，单独日历是重复），「公司事件」搬进了复盘区
 * （/review/events）。本文件不再渲染页面，进来直接送过去。
 *
 * 你需要知道的：
 * - 书签、手机桌面快捷方式里的旧链接（含 /calendar?tab=events）靠这层不断链。
 * - 交易日历数据链路（calendar.ts / fetch-calendar.py）已一并删除，不要再复活。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar")({
  beforeLoad: () => {
    throw redirect({ to: "/review/events" });
  },
});
