/**
 * 这个文件是干什么的：
 * 「多空辩论」页。同一份证据，正反双方各写一组「裁决点」，并排给读者看。
 *
 * 你需要知道的：
 * - **双方共用同一份证据**，页面上也明说这件事——不然读者会以为某一方多看了材料。
 * - 辩论的产出是「该盯什么」，不是「该买还是该卖」。哪一方越线，那一方整段不出
 *   并说明原因；两边都失败也两边都显示，**空着一侧比显示失败更糟**（读者会以为
 *   这一侧没有反面意见）。
 */

import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { runResearch } from "@/lib/market/research";
import { collectEvidence, runAiSynthesis } from "@/lib/market/research-ai";
import { runDebate, type DebateSide } from "@/lib/market/debate";
import { loadValuationHistory, valuationPosition } from "@/lib/market/pe-history";
import { getSymbolNews, loadUniverse } from "@/lib/market/quotes.functions";
import { callAI, readAIConfig } from "@/lib/market/factor-queue";

export const Route = createFileRoute("/debate")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q.trim().slice(0, 20) : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    // 统一返回形状：每个分支都带 q/sides/evidenceCount/name/why，
    // 不然组件的 data.q 会掉进联合类型的缝隙里。
    const empty = { q: deps.q, sides: [] as DebateSide[], evidenceCount: 0, name: "", why: null as string | null };
    if (!deps.q) return { ...empty, q: "" };

    const [news, uni] = await Promise.all([
      getSymbolNews({ data: { q: deps.q } }).catch(() => null),
      loadUniverse(false).catch(() => null),
    ]);
    if (!news?.picked) return { ...empty, why: "没找到这只票" };

    const quote = uni?.quotes.find((row) => row.id === news.picked!.id) ?? null;
    if (!quote) return { ...empty, name: news.picked.name, why: "找到资讯但没拿到行情快照" };

    const history = await loadValuationHistory(quote.code).catch(() => null);
    const valuation = valuationPosition(history);
    const report = runResearch({ quote, articles: news.articles, valuation });
    const evidenceIds = collectEvidence(report.stages).map((e) => e.id);

    const caller = async (prompt: string) => {
      const cfg = await readAIConfig();
      if (!cfg) throw new Error("没有配置可用的 AI 档案（/ai 页可以配）");
      return callAI(cfg, prompt, { layer: "debate", trigger: "manual" });
    };
    const debate = await runDebate(report.stages, report.symbol, report.name, caller, evidenceIds);
    return { q: deps.q, ...debate, name: report.name, why: null };
  },
  component: DebatePage,
});

function SideCard({ side }: { side: DebateSide }) {
  const tone = side.role === "bull" ? "text-up" : "text-down";
  return (
    <Panel
      id={`debate-${side.role}`}
      title={<span className={tone}>{side.label}</span>}
      note={<span className="text-xs text-muted">{side.role === "bull" ? "只看支持面的证据" : "只看反对面的证据"}</span>}
    >
      {side.status === "ok" ? (
        <>
          <div className="px-3 py-2">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{side.text}</p>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[10px] text-muted">
            {side.chain ? <code className="font-mono">{side.chain}</code> : null}
            {side.numbersReplaced > 0 ? <span className="text-warn">{side.numbersReplaced} 个数字无出处，已换成（略※）</span> : null}
            {side.refs.length > 0 ? <span>引用 {side.refs.length} 条证据</span> : null}
            <span>{(side.ms / 1000).toFixed(1)} 秒</span>
          </div>
        </>
      ) : (
        <div className="px-3 py-3">
          <p className={"text-xs leading-relaxed " + (side.status === "refused" ? "text-warn" : "text-muted")}>
            {side.why ?? "这一方没有产出"}
          </p>
          <p className="mt-1 text-[10px] text-muted">
            {side.status === "refused"
              ? "赤轨不给买卖建议，越线的那段没有显示。"
              : "这一方没出声不代表没有意见——只是 AI 这次没说出来。"}
          </p>
        </div>
      )}
    </Panel>
  );
}

function DebatePage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [value, setValue] = useState(search.q);
  useEffect(() => setValue(search.q), [search.q]);

  return (
    <Frame wide>
      <Panel title="多空辩论" note={<span className="text-xs text-muted">同一份证据 · 双方都只给观察点</span>}>
        <div className="p-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate({ to: "/debate", search: { q: value.trim() } });
            }}
          >
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="输入股票代码或名称，例如 600519"
              aria-label="搜索股票"
              className="min-w-0 flex-1 rounded border border-line bg-surface px-2.5 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent"
            />
            <button
              type="submit"
              className="shrink-0 rounded bg-brand px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
            >
              开始辩论
            </button>
          </form>
        </div>
      </Panel>

      {!data.q ? (
        <Panel title="还没选股票">
          <StateBlock
            kind="empty"
            title="输入一只股票开始"
            hint="正反双方读同一份六阶段证据，各写一组「看到什么就该重新乐观/警惕」的裁决点。两边都只给观察点，不给买卖建议。"
          />
        </Panel>
      ) : null}

      {data.q && data.sides.length === 0 ? (
        <Panel title="这只票没法辩">
          <StateBlock
            kind="error"
            title={data.why ?? "没找到这只票"}
            hint="检查代码或名称；停牌、退市和刚换代码的票可能不在股票池里。"
          />
        </Panel>
      ) : null}

      {data.sides.length === 2 ? (
        <>
          <div className="grid gap-2 lg:grid-cols-2">
            <SideCard side={data.sides[0]!} />
            <SideCard side={data.sides[1]!} />
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted">
            双方共用 {data.evidenceCount} 条证据（和个股研判页同一份）。
            **同一批证据能读出两种走向，这本身就是信息**——它告诉你该盯的是什么，不告诉你该做什么。
            想看完整证据和估值分位？<Link to="/research" search={{ q: data.q }} className="text-accent hover:underline">去个股研判</Link>
          </p>
        </>
      ) : null}
    </Frame>
  );
}
