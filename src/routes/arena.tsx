/**
 * /arena 重定向到 /arena/signals。
 */

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/arena")({
  // /arena 没有 index 子路由，直接打开会匹配不到子路由、Outlet 空着 → 黑屏。
  // 注释里一直说「重定向到 /arena/signals」，但之前漏写了，现在补上。
  // 注意：父路由的 beforeLoad 在访问子路由（/arena/signals 等）时也会执行，
  // 所以必须用 location.pathname 守卫，只在「恰好是 /arena」时跳，否则子路由会被重定向到自身形成死循环。
  beforeLoad: ({ location }) => {
    if (location.pathname === "/arena") {
      throw redirect({ to: "/arena/signals" });
    }
  },
  component: () => <Outlet />,
});