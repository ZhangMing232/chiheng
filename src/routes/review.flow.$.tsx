/**
 * 这个文件是干什么的：
 * 旧资金流向子路由的兜底重定向。/review/flow/<子页> → /flow/<子页>，
 * search 参数原样带过去（板块页要 board，丢了就等于换了页面）。
 *
 * 用 href 而不是 to：各子页的 search 校验不同，静态类型挨个对齐不值得——
 * 重定向是运行时的兼容层，宽松优先。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

const KNOWN = ["north", "industries", "sectors", "stocks", "hot", "close", "margin", "futures"];

export const Route = createFileRoute("/review/flow/$")({
  beforeLoad: ({ params, search }) => {
    const rest = (params as { _splat?: string })._splat ?? "";
    const target = KNOWN.includes(rest) ? rest : "";
    const qs = new URLSearchParams(search as Record<string, string>).toString();
    throw redirect({ href: `/flow/${target}${qs ? `?${qs}` : ""}`, replace: true });
  },
});
