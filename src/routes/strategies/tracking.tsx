/**
 * /strategies/tracking → /strategies/signals 重定向。
 *
 * 2026-11-05 二次整理：「战绩跟踪」明细并进「跟单信号」页（同一份 tracking
 * 数据的摘要与明细，没必要两个 tab）。这个地址是合并当天产生的新地址，
 * 用重定向接住，不留死链。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/strategies/tracking")({
  beforeLoad: () => {
    throw redirect({ to: "/strategies/signals", replace: true });
  },
});
