/**
 * /arena/* 旧地址全量重定向（splat 路由）。
 *
 * 2026-11-05 用户拍板：策略竞技场并入策略看板——四个子页搬进 /strategies 家族
 * （signals→/strategies/signals、strategies→/strategies/manage、tracking→/strategies/signals、
 * autopsy→/strategies/autopsy）。本文件只负责把旧书签接过来，不渲染任何东西。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

const ARENA_REDIRECTS: Record<string, string> = {
  "/arena": "/strategies/signals",
  "/arena/signals": "/strategies/signals",
  "/arena/strategies": "/strategies/manage",
  "/arena/tracking": "/strategies/signals",
  "/arena/autopsy": "/strategies/autopsy",
};

export const Route = createFileRoute("/arena/$")({
  beforeLoad: ({ location }) => {
    const to = ARENA_REDIRECTS[location.pathname] ?? "/strategies/signals";
    throw redirect({ to, replace: true });
  },
});
