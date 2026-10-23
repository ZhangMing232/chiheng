/**
 * 这个文件是干什么的：
 * 旧路由兼容。2026-10-23 资金流向并入了「每日复盘」区（/review/flow，复盘的
 * 一个子区），本文件不再渲染页面，进来直接送过去，search 参数原样带上。
 *
 * 你需要知道的：
 * - 书签、手机桌面快捷方式里的旧链接（含 /flow/sectors?board=BKxxx）靠这层不断链。
 * - 正文已搬到 routes/review/flow/ 下，改功能去那边。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/flow")({
  beforeLoad: () => {
    throw redirect({ to: "/review/flow" });
  },
});
