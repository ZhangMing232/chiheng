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
import { createServerFn } from "@tanstack/react-start";
import { Frame } from "@/components/screener/nav";
import { RESEARCH_TABS, SectionTabs } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { qParam } from "@/lib/search-params";
import { runResearch } from "@/lib/market/research";
import { collectEvidence, runAiSynthesis } from "@/lib/market/research-ai";
import { runDebate, type DebateSide } from "@/lib/market/debate";
import { loadValuationHistory, valuationPosition } from "@/lib/market/pe-history";
import { getSymbolNews, getUniverse } from "@/lib/market/quotes.functions";
import { callAI, readAIConfig } from "@/lib/market/factor-queue";
import { readActiveMeta } from "@/lib/market/ai-profiles";

export const Route = createFileRoute("/research/debate")({
  validateSearch: (search: Record<string, unknown>) => ({ q: qParam(search) }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => runDebatePage({ data: deps.q }),
  // loader 要调两轮 AI（正反双方各一次），真实耗时 1-2 分钟。
  // 不给 pending 态的话，点「开始辩论」后页面纹丝不动，像没反应（2026-10-21 用户实测反馈）。
  pendingComponent: () => (
    <Frame wide>
      <Panel title="多空辩论">
        <StateBlock kind="loading" title="双方正在读证据、写裁决点" hint="真实耗时约 1-2 分钟（正反双方各调一次 AI），请留在本页等结果。" />
      </Panel>
    </Frame>
  ),
  component: DebatePage,
});

/**
 * 多空辩论数据组装。**只能在服务端跑**（读落盘数据、调 AI），
 * 客户端导航时经 RPC 到服务端执行——2026-10-17 之前写在 loader 里，
 * SPA 导航会让它在浏览器里跑、fs 一调就整页报错（同 /backtest 的教训）。
 */
const runDebatePage = createServerFn({ method: "GET" })
  .validator((q: unknown) => (typeof q === "string" ? q.trim().slice(0, 20) : ""))
  .handler(async ({ data: q }) => {
    // 统一返回形状：每个分支都带 q/sides/evidenceCount/name/why，
    // 不然组件的 data.q 会掉进联合类型的缝隙里。
    const empty = { q, sides: [] as DebateSide[], evidenceCount: 0, name: "", why: null as string | null };
    if (!q) return { ...empty, q: "" };

    const [news, uni] = await Promise.all([
      getSymbolNews({ data: { q } }).catch(() => null),
      getUniverse({ data: { refresh: false } }).catch(() => null),
    ]);
    if (!news?.picked) return { ...empty, why: "没找到这只票" };

    const quote = uni?.quotes.find((row) => row.id === news.picked!.id) ?? null;
    if (!quote) return { ...empty, name: news.picked.name, why: "找到资讯但没拿到行情快照" };

    // GET loader 只出规则报告，**不调 AI**（2026-11-16 根治：打开页面不该花钱）。
    const history = await loadValuationHistory(quote.code).catch(() => null);
    const valuation = valuationPosition(history);
    const report = runResearch({ quote, articles: news.articles, valuation });
    const evidenceIds = collectEvidence(report.stages).map((e) => e.id);
    // 用 skipped 侧占位——页面本来就会渲染 skipped 状态。
    const skippedSides: DebateSide[] = (["bull", "bear"] as const).map((role) => ({
      role, label: role === "bull" ? "多方" : "空方", status: "skipped" as const,
      text: null, why: "要点「生成多空辩论」按钮才会调用 AI", refs: [], chain: null,
      blocked: 0, numbersReplaced: 0, ms: 0,
    }));
    return {
      q,
      sides: skippedSides,
      evidenceCount: evidenceIds.length,
      name: report.name,
      why: null,
      // 传给 POST 用（不回客户端也行，POST 会重算；这里只给按钮判断用）。
      symbol: report.symbol,
      stages: report.stages,
      evidenceIds,
    };
  });

/** 显式按钮：点「生成多空辩论」才调两方 AI，主人 + 总开关双闸。 */
export const runDebateAI = createServerFn({ method: "POST" })
  .validator((q: unknown) => (typeof q === "string" ? q.trim().slice(0, 20) : ""))
  .handler(async ({ data: q }) => {
    const { requirePrincipal } = await import("@/lib/auth/verify.server");
    const { isOwner } = await requirePrincipal();
    if (!isOwner) return { ok: false as const, error: "只有主人账号能调用 AI", sides: [] as DebateSide[] };
    const { isAgentOn } = await import("@/lib/market/agent-jobs");
    if (!(await isAgentOn())) return { ok: false as const, error: "小机已被总开关停用——去 /ai 概览页打开再生成", sides: [] as DebateSide[] };
    // 重算规则报告（POST 独立执行，不依赖 GET 的内存）
    const [news, uni] = await Promise.all([
      getSymbolNews({ data: { q } }).catch(() => null),
      getUniverse({ data: { refresh: false } }).catch(() => null),
    ]);
    if (!news?.picked) return { ok: false as const, error: "没找到这只票", sides: [] as DebateSide[] };
    const quote = uni?.quotes.find((row) => row.id === news.picked!.id) ?? null;
    if (!quote) return { ok: false as const, error: "找到资讯但没拿到行情快照", sides: [] as DebateSide[] };
    const { loadValuationHistory, valuationPosition } = await import("@/lib/market/pe-history");
    const history = await loadValuationHistory(quote.code).catch(() => null);
    const report = runResearch({ quote, articles: news.articles, valuation: valuationPosition(history) });
    const evidenceIds = collectEvidence(report.stages).map((e) => e.id);
    const debate = await runDebate(
      report.stages, report.symbol, report.name,
      async (prompt: string) => {
        const cfg = await readAIConfig();
        if (!cfg) throw new Error("没有配置可用的 AI 档案（/ai 页可以配）");
        const meta = await readActiveMeta(); // 价格快照入账（2026-11-16 修）
        return callAI(cfg, prompt, {
          layer: "debate", trigger: "manual",
          ...(meta ? { profileId: meta.profileId, pricePromptPerM: meta.pricePromptPerM, priceCompletionPerM: meta.priceCompletionPerM } : {}),
        });
      },
      evidenceIds,
    );
    return { ok: true as const, error: null, sides: debate.sides, evidenceCount: debate.evidenceCount, name: report.name };
  });

function SideCard({ side }: { side: DebateSide }) {
  const tone = side.role === "bull" ? "text-up" : "text-down";
  return (
    <Panel
      id={`debate-${side.role}`}
      title={<span className={tone}>{side.label}</span>}
      note={<span className="text-xs text-muted">{side.role === "bull" ? "只看支持面的证据" : "只看反对面的证据"}</span>}
    >
      <h1 className="font-display text-xl font-medium tracking-wide">研究</h1>
      <SectionTabs ariaLabel="研究" tabs={RESEARCH_TABS} />
      {side.status === "ok" ? (
        <>
          <div className="px-3 py-2">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{side.text}</p>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[12px] text-muted">
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
          <p className="mt-1 text-[12px] text-muted">
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
  const [sides, setSides] = useState<DebateSide[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  useEffect(() => {
    setValue(search.q);
    setSides(null);      // 换股票清掉上一场的辩论
    setAiError(null);
  }, [search.q]);

  async function generateDebate() {
    if (!search.q || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await runDebateAI({ data: search.q });
      if (res.ok) setSides(res.sides);
      else setAiError(res.error ?? "生成失败");
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setAiBusy(false);
    }
  }

  const shownSides = sides ?? data.sides;

  return (
    <Frame
      wide
      status={{
        label: "对照",
        // **真实数据**：双方共用证据条数。status 是双方各自的状态
        // （ok / refused / failed / skipped）——有一方没跑出来就说出来，
        // 不能只显示"看起来辩过了"。
        value: data.evidenceCount > 0 ? `${data.evidenceCount} 条证据` : null,
        tone: shownSides.every((side) => side.status === "ok")
          ? "ok"
          : shownSides.some((side) => side.status === "ok")
            ? "warn"
            : "neutral",
      }}
      ornamentContent={
        shownSides.length > 0 ? (
          <span className="text-[12px] tabular-nums">
            {shownSides
              .map((side) => `${side.label} ${side.status === "ok" ? "已出" : side.status === "refused" ? "拒答" : side.status === "skipped" ? "跳过" : "失败"}`)
              .join(" · ")}
          </span>
        ) : (
          <span className="text-[12px]">还没有辩论结果</span>
        )
      }
    >
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
              查这只票（免费）
            </button>
            <button
              type="button"
              disabled={!search.q || aiBusy}
              onClick={() => void generateDebate()}
              className="shrink-0 rounded border border-brand px-3 py-1.5 text-sm font-medium text-brand transition hover:bg-brand hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {aiBusy ? "辩论中（约 1 分钟）…" : "生成 AI 辩论（消耗额度）"}
            </button>
          </form>
          <p className="mt-2 text-[12px] text-muted">
            {aiBusy ? "正在调用模型，请留在本页" : "查票免费；AI 辩论需点按钮才花钱。规则证据在下方照常显示。"}
            {aiError ? <span className="ml-2 text-down">{aiError}</span> : null}
          </p>
        </div>
      </Panel>

      {!data.q ? (
        <Panel title="还没选股票">
          <StateBlock
            kind="empty"
            title="输入一只股票开始"
            hint="正反双方读同一份七阶段证据，各写一组「看到什么就该重新乐观/警惕」的裁决点。两边都只给观察点，不给买卖建议。"
          />
        </Panel>
      ) : null}

      {data.q && shownSides.length === 0 ? (
        <Panel title="这只票没法辩">
          <StateBlock
            kind="error"
            title={data.why ?? "没找到这只票"}
            hint="检查代码或名称；停牌、退市和刚换代码的票可能不在股票池里。"
          />
        </Panel>
      ) : null}

      {shownSides.length === 2 ? (
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
