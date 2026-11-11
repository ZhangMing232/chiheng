/**
 * 这个文件是干什么的：
 * 「题材」页——2026-11-11 合并进 /rotation（题材轮动）后，这里只做 307 重定向。
 *
 * 为什么合并：用户指出 /review/theme（题材热度榜）和 /rotation（题材轮动）是两个
 * 重复页面，同一批题材看两遍。现在统一到 /rotation，那边按弈盘 themes.html 的
 * 题材库口径做（题材 + 涨停 + 龙头 + 轮动方向 + 成分股）。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/review/theme")({
  beforeLoad: () => {
    throw redirect({ to: "/rotation", replace: true });
  },
});
