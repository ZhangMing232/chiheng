/**
 * 旧路由兼容。/hotmoney 2026-11-11 并进「游资与席位」区（/youzi/track）。
 * 本文件不再渲染页面，进来直接送过去。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/hotmoney")({
  beforeLoad: () => {
    throw redirect({ to: "/youzi/track", replace: true });
  },
});
