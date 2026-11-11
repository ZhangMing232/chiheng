/**
 * /youzi 的默认子页：落在「游资追踪」。追踪是这组的第一段（今天谁在买），
 * 从它进门再往「战绩」走是顺的；反过来从战绩进门会先看到一堆历史统计。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/youzi/")({
  beforeLoad: () => {
    throw redirect({ to: "/youzi/track", replace: true });
  },
});
