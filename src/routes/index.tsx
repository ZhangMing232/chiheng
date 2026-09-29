import { createFileRoute } from "@tanstack/react-router";
import { Screener } from "@/components/screener/screener";
import { sessionPhase } from "@/lib/market/session";
import type { IndexQuote } from "@/lib/market/types";
import { getIndices, getUniverse } from "@/lib/market/quotes.functions";

export const Route = createFileRoute("/")({
  loader: async () => {
    const phase = sessionPhase();
    try {
      const [universe, indices] = await Promise.all([
        getUniverse({ data: { refresh: false } }),
        getIndices(),
      ]);
      return {
        universe,
        indices,
        error: universe.stale ? "行情源不稳定，先显示上一轮数据" : null,
        phase,
      };
    } catch (error) {
      return {
        universe: null,
        indices: [] as IndexQuote[],
        error: error instanceof Error ? error.message : "行情暂时拉不下来，请稍后再刷新",
        phase,
      };
    }
  },
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  return <Screener initial={data} />;
}
