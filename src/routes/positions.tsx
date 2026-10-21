/**
 * 这个文件是干什么的：
 * 旧路由兼容。2026-10-21 策略追踪并入了「策略」区（/strategies/positions，
 * 和策略选股同一个页面的两个子页），本文件不再渲染页面，进来直接送过去。
 *
 * 你需要知道的：
 * - 书签、手机桌面快捷方式、外部文章里的旧链接都靠这层不断链。
 * - 正文已搬到 routes/strategies/positions.tsx，改功能去那边。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/positions")({
  beforeLoad: () => {
    throw redirect({ to: "/strategies/positions" });
  },
});
