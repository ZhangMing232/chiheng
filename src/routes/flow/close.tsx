/**
 * /flow/close 已并入 /flow/（2026-11-12）。
 *
 * 为什么并：收盘快照本来就是「同一条资金时间轴上的另一个时点」，不是一个独立任务。
 * 让它单独占一个 tab，等于把时间选择器做成了页面。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/flow/close")({
  beforeLoad: () => {
    throw redirect({ to: "/flow" });
  },
});
