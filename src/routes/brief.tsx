/**
 * 旧路由兼容。/brief 2026-11-11 并进「题材」区（/themes/brief）。
 * 本文件不再渲染页面，进来直接送过去。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/brief")({
  beforeLoad: () => {
    throw redirect({ to: "/themes/brief", replace: true });
  },
});
