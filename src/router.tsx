/**
 * 这个文件是干什么的：
 * 把各个页面的地址装成一个路由器。哪个地址显示什么，写在 routes 目录里。
 *
 * 你需要知道的：
 * 这里不画页面，也不拉行情。页面出错时，用统一的错误界面接住。
 */

import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

/** 创建一个路由器。某个页面抛错时，用统一的错误组件显示。 */
export function getRouter() {
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    // 30 秒内返回刚看过的页面直接用缓存，不重新拉数据（公网隧道往返贵，反复点来回页面不该每次等）。
    defaultStaleTime: 30_000,
    // 手指碰到/鼠标悬停导航链接就预取该页数据，点击时数据已经在了。
    // 走 Cloudflare Tunnel 时每次往返约 300ms+，预取能把这段时间藏起来。
    defaultPreload: "intent",
  });
}
