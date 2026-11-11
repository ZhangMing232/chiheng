/**
 * /themes 的默认子页：直接落在「市场情报」。
 *
 * 为什么是情报而不是简报：情报是这条链路的第一段（消息从哪来），从它进门读起来是
 * 顺着走的；简报是最后一段，从结论进门会看不懂结论哪来的。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/themes/")({
  beforeLoad: () => {
    throw redirect({ to: "/themes/intel", replace: true });
  },
});
