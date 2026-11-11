/**
 * 旧路由兼容。/intel 2026-11-11 并进「题材」区（/themes/intel）。
 * 本文件不再渲染页面，进来直接送过去。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/intel")({
  beforeLoad: () => {
    throw redirect({ to: "/themes/intel", replace: true });
  },
});
