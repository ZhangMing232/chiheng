/**
 * 这个文件是干什么的：
 * 「题材」页——2026-11-11 后统一到题材区（/themes/rotation，题材轮动），这里只做 307。
 *
 * 为什么：用户指出 /review/theme（题材热度榜）和原来的 /rotation（题材轮动）是
 * 两个重复页面，同一批题材看两遍。统一之后又赶上 11-11 的题材三页合并，
 * 最终落在 /themes/rotation——那边按弈盘 themes.html 的题材库口径做
 * （题材 + 涨停 + 龙头 + 轮动方向 + 成分股）。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/review/theme")({
  beforeLoad: () => {
    throw redirect({ to: "/themes/rotation", replace: true });
  },
});
