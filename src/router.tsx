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
  return createRouter({ routeTree, defaultErrorComponent: AppErrorComponent });
}
