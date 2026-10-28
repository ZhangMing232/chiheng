/**
 * /arena 重定向到 /arena/signals。
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/arena")({
  beforeLoad: () => {
    return { redirect: { to: "/arena/signals" } };
  },
  component: () => null,
});