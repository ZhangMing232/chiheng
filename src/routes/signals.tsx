/**
 * 这个文件是干什么的：
 * 旧路由兼容。2026-10-21 信号并入了「复盘」区（/review/signals，和每日复盘
 * 同一个页面的两个子页），本文件不再渲染页面，进来直接送过去，日期参数带上。
 *
 * 你需要知道的：
 * - 书签、手机桌面快捷方式里的旧链接靠这层不断链。
 * - 正文已搬到 routes/review/signals.tsx，改功能去那边。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/signals")({
  // 本路由没有 validateSearch，search 的静态类型是 {}；旧链接带不带 date 都要能接，
  // 按宽松字典读，传给目标子页（它自己有日期格式校验）。
  beforeLoad: ({ search }) => {
    const date = (search as Record<string, unknown>).date;
    throw redirect({ to: "/review/signals", search: typeof date === "string" && date ? { date } : {} });
  },
});
