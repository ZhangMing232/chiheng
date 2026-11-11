/**
 * 这个文件是干什么的：
 * 旧路由兼容。资金流向 2026-10-23 并进复盘（/review/flow），2026-11-11 又拆回
 * 平级（/flow）。本文件不再渲染页面，进来直接送去 /flow。
 *
 * 你需要知道的：
 * - 那三周里存下的书签、手机桌面快捷方式靠这层不断链。
 * - 正文在 routes/flow/ 下，改功能去那边。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/review/flow")({
  beforeLoad: () => {
    throw redirect({ to: "/flow", replace: true });
  },
});
