/**
 * 这个文件是干什么的：
 * Better Auth 的 HTTP 入口——/api/auth/** 全部转给 src/lib/auth/server.ts
 * 的 auth.handler（注册 / 登录 / 会话 / 退出都走这里）。
 *
 * 为什么走 Nitro 路由而不是 TanStack 文件路由：这版 TanStack Start（1.168）
 * 的 createFileRoute 不认 server.handler 选项（静默忽略，实测 handler 不触发、
 * 请求落到 SPA HTML）。Nitro 的 server/routes/ 是框架级扫描（vite.config 配了
 * serverDir: "./server"），dev/build 都生效。h3 的 fromWebHandler 正好把
 * Better Auth 的 Web 标准 handler 包成 Nitro event handler。
 *
 * 路径为什么是 [...].ts：Better Auth 的端点带任意层级（/sign-up/email、
 * /get-session……），Nitro 3 的 [...] 文件名收编剩余全部路径。
 */

import { fromWebHandler } from "h3";
import { auth } from "../../../../src/lib/auth/server";

export default fromWebHandler((request) => auth.handler(request));
