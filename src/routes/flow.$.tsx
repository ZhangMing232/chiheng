/**
 * 这个文件是干什么的：
 * 旧资金流向子路由的兜底重定向。2026-10-23 资金流向并入复盘（/review/flow/*），
 * 旧书签（/flow/stocks、/flow/sectors?board=BKxxx 等）靠这层不断链：
 * /flow/<子页> → /review/flow/<子页>，search 参数原样带过去。
 *
 * 用 href 而不是 to：目标子页的 search 校验各不相同（sectors 要 board），
 * 静态类型挨个对齐不值得——重定向是运行时的兼容层，宽松优先。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

const KNOWN = ["north", "industries", "sectors", "stocks", "hot", "close", "margin", "futures"];

export const Route = createFileRoute("/flow/$")({
  beforeLoad: ({ params, search }) => {
    const rest = (params as { _splat?: string })._splat ?? "";
    const target = KNOWN.includes(rest) ? rest : "";
    const qs = new URLSearchParams(search as Record<string, string>).toString();
    throw redirect({ href: `/review/flow/${target}${qs ? `?${qs}` : ""}` });
  },
});
