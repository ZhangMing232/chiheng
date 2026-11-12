/**
 * /flow/industries 已并入 /flow/sectors?view=live（2026-11-12）。
 *
 * 为什么并：它（腾讯实时行业资金榜，分钟级）和 /flow/sectors（东财三级行业 + 月度温度计）
 * 回答的是同一个问题「钱在往哪个方向去」，只是口径不同。原来各占一个 tab，
 * 8 个平级 tab 里有一半是同义。
 *
 * 这个路由只做 307，别再往里加内容——两页各写一份必然走形。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/flow/industries")({
  beforeLoad: () => {
    throw redirect({ to: "/flow/sectors", search: { board: "", view: "live" } });
  },
});
