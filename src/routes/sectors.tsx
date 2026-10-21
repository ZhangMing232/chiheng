/**
 * 这个文件是干什么的：
 * 旧路由兼容。2026-10-21 板块页并入了「资金流向」区（/flow/sectors，和资金流向
 * 同一个页面的两个子页），本文件不再渲染页面，进来直接送过去，board 参数带上。
 *
 * 你需要知道的：
 * - 书签、手机桌面快捷方式里的旧链接（含 /sectors?board=BKxxx）靠这层不断链。
 * - 正文已搬到 routes/flow/sectors.tsx，改功能去那边。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sectors")({
  // 本路由没有 validateSearch，search 的静态类型是 {}；旧链接带不带 board 都要能接，
  // 按宽松字典读，传给目标子页（它自己有 BK 代码格式校验）。
  beforeLoad: ({ search }) => {
    const board = (search as Record<string, unknown>).board;
    throw redirect({
      to: "/flow/sectors",
      // 目标子页的 validateSearch 把 board 定成必填（缺省 ""），这里必须始终带上。
      search: { board: typeof board === "string" && board ? board : "" },
    });
  },
});
