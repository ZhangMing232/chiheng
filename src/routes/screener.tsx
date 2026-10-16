/**
 * 这个文件是干什么的：
 * 打开网站看到的第一页，也就是选股页。先把行情、规则、偏好和账取齐，再交给选股界面画出来。
 *
 * 你需要知道的：
 * 取数失败时页面仍会打开，并写明行情暂时拉不下来。成交不在这一步记。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Screener } from "@/components/screener/screener";
import { sessionPhase } from "@/lib/market/session";
import type { IndexQuote } from "@/lib/market/types";
import { getIndices, getPrefs, getRecorder, getRules, getServerJournal } from "@/lib/market/quotes.functions";
import { DEFAULT_RULES } from "@/lib/market/rules";
import { DEFAULT_PREFS } from "@/lib/market/prefs";

/** 首页路由。进页面之前把选股要的数据一次取好；失败就用空数据加一句说明。
 *  注意：全市场快照（~5300 只、1.2MB）刻意不进 SSR——手机端解析会卡死主线程。
 *  首屏先渲染外壳，universe 由组件挂载后客户端拉（screener.tsx 的 refresh）。 */
export const Route = createFileRoute("/screener")({
  loader: async () => {
    const phase = sessionPhase();
    try {
      const [indices, journal, rules, prefs, recorder] = await Promise.all([
        getIndices(),
        getServerJournal(),
        getRules(),
        getPrefs(),
        getRecorder(),
      ]);
      return {
        universe: null,
        indices,
        journal: journal.days,
        personal: journal.personal,
        journalWhy: journal.why,
        rules,
        prefs,
        recorder,
        error: null,
        phase,
      };
    } catch (error) {
      return {
        universe: null,
        indices: [] as IndexQuote[],
        journal: [],
        personal: false,
        journalWhy: "页面初始化时出了错",
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
