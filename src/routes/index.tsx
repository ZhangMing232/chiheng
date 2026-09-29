import { createFileRoute } from "@tanstack/react-router";
import { Screener } from "@/components/screener/screener";
import { sessionPhase } from "@/lib/market/session";
import type { IndexQuote } from "@/lib/market/types";
import { getIndices, getPrefs, getRecorder, getRules, getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import { DEFAULT_RULES } from "@/lib/market/rules";
import { DEFAULT_PREFS } from "@/lib/market/prefs";

export const Route = createFileRoute("/")({
  loader: async () => {
    const phase = sessionPhase();
    try {
      const [universe, indices, journal, rules, prefs, recorder] = await Promise.all([
        getUniverse({ data: { refresh: false } }),
        getIndices(),
        getServerJournal(),
        getRules(),
        getPrefs(),
        getRecorder(),
      ]);
      return {
        universe,
        indices,
        journal: journal.days,
        personal: journal.personal,
        rules,
        prefs,
        recorder,
        error: universe.stale ? "行情源不稳定，先显示上一轮数据" : null,
        phase,
      };
    } catch (error) {
      return {
        universe: null,
        indices: [] as IndexQuote[],
        journal: [],
        personal: false,
        rules: DEFAULT_RULES,
        prefs: DEFAULT_PREFS,
        recorder: { at: null, ok: true },
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
