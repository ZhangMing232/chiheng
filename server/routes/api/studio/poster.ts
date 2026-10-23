/**
 * 这个文件是干什么的：
 * 自媒体配图的**服务端渲染入口**（L1 改造）。POST 一个 spec 进来，返回
 * 渲染好的 PNG（dataURL）。
 *
 * 为什么走 Nitro 路由而不是 TanStack serverFn：
 * - @resvg/resvg-js 是**原生模块**，只能在服务端跑；serverFn 也能跑服务端，
 *   但 Nitro 路由更直白（curl 就能验，不用猜 serverFn 的 RPC 端点格式）。
 * - 这版 TanStack Start（1.168）的 createFileRoute 不认 server.handler 选项
 *   （静默忽略、请求落到 SPA HTML）——同目录的 auth/[...].ts 注释里记了这个坑。
 *
 * 你需要知道的：
 * - **失败必须说清原因**：字体缺失/字形没生效都返回 {ok:false,error}，
 *   页面据此回退浏览器 canvas 路线，并把原因显示出来。
 * - 回环请求不受访问口令闸门影响（本机调试方便）。
 */

import { defineEventHandler, readBody, setResponseStatus } from "h3";
import { FONT_CANDIDATES, renderPosterPayload } from "../../../../src/lib/market/studio-svg";
import type { StudioSpec } from "../../../../src/lib/market/studio-poster";

type Body = { spec?: StudioSpec; format?: "vertical" | "square" };

export default defineEventHandler(async (event) => {
  const body = (await readBody<Body>(event).catch(() => ({}))) as Body;
  const spec = body?.spec;
  if (!spec || typeof spec.title !== "string") {
    setResponseStatus(event, 400);
    return { ok: false, error: "请求里没有 spec" };
  }
  const format = body?.format === "square" ? "square" : "vertical";
  const out = await renderPosterPayload(spec, format, FONT_CANDIDATES);
  if (!out.ok) setResponseStatus(event, 500);
  return out;
});
