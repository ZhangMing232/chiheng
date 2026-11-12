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
import { getIndices, getPrefs, getRecorder, getRules, getServerJournal, getStrategyGates } from "@/lib/market/quotes.functions";
import { DEFAULT_RULES } from "@/lib/market/rules";
import { DEFAULT_PREFS } from "@/lib/market/prefs";
import { PixelHeader } from "@/components/pixel-header";

/** 首页路由。进页面之前把选股要的数据一次取好；失败就用空数据加一句说明。
 *  注意：全市场快照（~5300 只、1.2MB）刻意不进 SSR——手机端解析会卡死主线程。
 *  首屏先渲染外壳，universe 由组件挂载后客户端拉（screener.tsx 的 refresh）。 */
export const Route = createFileRoute("/strategies/screener")({
  loader: async () => {
    const phase = sessionPhase();
    try {
      const [indices, journal, rules, prefs, recorder, gateData] = await Promise.all([
        getIndices(),
        getServerJournal(),
        getRules(),
        getPrefs(),
        getRecorder(),
        getStrategyGates(),
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
        // 首屏就带上闸门状态：不然 SSR 会先把被停用的策略画进「现役策略」，
        // 客户端拉到闸门再抽掉，用户会看到闪一下。getStrategyGates 自带兜底，读不到返回空。
        gates: gateData.gates,
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
        // 初始化整体失败时闸门状态也没拿到：空对象 = 没有策略被停用，
        // 页面照常打开，别让一块状态把整页拖成报错。
        gates: {},
        error: error instanceof Error ? error.message : "行情暂时拉不下来，请稍后再刷新",
        phase,
      };
    }
  },
  component: Home,
});

function Home() {
  const data = Route.useLoaderData();
  return (
    <div className="flex flex-col gap-2">
      <PixelHeader label="STRATEGY // PICK" meta="选策略 → 设范围 → 跑 → 加跟踪；成交不在这一步记" />
      <Screener initial={data} />
    </div>
  );
}
