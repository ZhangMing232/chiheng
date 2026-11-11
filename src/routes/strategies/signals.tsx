/**
 * /strategies/signals → /strategies/positions 重定向。
 *
 * 2026-11-11 整合：用户要求「策略追踪」和「跟单信号」两个页面合并。既然信号页
 * 的内容（今日信号/战绩跟踪/逐条明细/短线形态台账）并进了持仓页的「跟单」子 tab，
 * 这个地址就只保留重定向，书签和内链不断。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/strategies/signals")({
  beforeLoad: () => {
    throw redirect({ to: "/strategies/positions", replace: true });
  },
});
