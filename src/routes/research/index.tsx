/**
 * 这个文件是干什么的：
 * 「个股研判」页。学 Vibe-Research 的 company-research 七阶段 SOP：输入一只股票，
 * 按六个固定阶段把「知道什么、凭什么知道、还不知道什么」分开摆出来。
 *
 * 你需要知道的（纪律）：
 * - **这一页不给买卖建议**。结论只在四类里说话：数据、分析框架、情景概率、裁决点
 *   （red-line.ts 的 ALLOWED_OUTPUTS）。流水线自己的模板产出也过一次红线，由测试钉住。
 * - 每一阶段带一个「缺什么」的块。拿不到的数据写缺口，**不许补 0 或留白**。
 * - 看好处的四档可信度跟着每条结论显示，读者知道自己信的是数据还是推断。
 */

import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Frame } from "@/components/screener/nav";
import { RESEARCH_TABS, SectionTabs } from "@/components/section-tabs";
import { Panel, Tag, pctClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { knowledgeFromReport, runResearch, type StageResult, type ResearchReport } from "@/lib/market/research";
import { collectEvidence, runAiSynthesis, type AiSynthesis } from "@/lib/market/research-ai";
import { linkifyEvidenceText } from "@/lib/market/evidence";
import { loadEarnings } from "@/lib/market/earnings-store";
import { loadFinancials } from "@/lib/market/financials-store";
import { fetchConsensusReports } from "@/lib/market/consensus-store";
import { aggregateConsensus } from "@/lib/market/consensus";
import { loadKnowledge, saveKnowledge } from "@/lib/market/knowledge-store";
import { loadKlines } from "@/lib/market/kline-store";
import { loadBoardMonthly, loadIndustry } from "@/lib/market/industry-store";
import { finestIndustry } from "@/lib/market/industry";
import { loadValuationHistory, valuationPosition, rankPhrase, type ValuationPosition } from "@/lib/market/pe-history";
import { callAI, readAIConfig } from "@/lib/market/factor-queue";
import { saveResearchReport } from "@/lib/market/reports.functions";
import { getSymbolNews, getUniverse } from "@/lib/market/quotes.functions";
import { qParam } from "@/lib/search-params";
import type { Quote } from "@/lib/market/types";
import type { StockArticle } from "@/lib/market/news";

/**
 * 研判页路由。地址栏里的 q 是搜索词。
 *
 * 报价要从全市场快照里捞：`getSymbolNews` 只给回资讯和一个带涨跌幅的命中项，
 * 研判要的 PE / PB / d60 那些只有 Quote 里有，所以两个接口一起拉。
 * 两个都拉失败时降级成「这只票现在查不到」，不让整页打不开。
 *
 * AI 综合在 loader 里跑（服务端）：注入的 caller 读 AI 档案 + 调 callAI。
 * **AI 挂了不影响这一页**——runAiSynthesis 自己降级成 failed 并带上原因，
 * 七阶段的规则结论照常显示。
 */
/**
 * 研判页数据组装。**只能在服务端跑**（读落盘数据、调 AI、写档案），
 * 客户端导航时经 RPC 到服务端执行——2026-10-17 之前写在 loader 里，
 * SPA 导航会让它在浏览器里跑、fs 一调就整页报错（同 /backtest 的教训）。
 */
const runResearchPage = createServerFn({ method: "GET" })
  .validator((q: unknown) => (typeof q === "string" ? q.trim().slice(0, 20) : ""))
  .handler(async ({ data: q }) => {
    if (!q) {
      return { q: "", quote: null, articles: [] as StockArticle[], valuation: null, why: null as string | null, ai: null };
    }
    const [news, uni] = await Promise.all([
      getSymbolNews({ data: { q } }).catch(() => null),
      getUniverse({ data: { refresh: false } }).catch(() => null),
    ]);
    if (!news) {
      return { q, quote: null, articles: [] as StockArticle[], valuation: null, why: "资讯接口暂时拉不下来", ai: null };
    }
    const quote: Quote | null = uni?.quotes.find((row) => row.id === news.picked?.id) ?? null;
    // 身份在这里解析：下面的知识库是按人落盘的，读写都要带本人 id。
    const { requireUserId } = await import("@/lib/auth/verify.server");
    const userId = await requireUserId();
    // 各数据源互不依赖，一次并发全拉上（原来逐个串行 await，每多一个源多一次往返）。
    // 估值历史（PE/PB 分位）来自 baostock 离线脚本，没跑过就是没有——
    // 页面会把它写成「缺口」，不用当日 PE 反推一个假的。
    // 财报比率传 quote.id（sh600519 这种带市场前缀），fundamentals.json 的 byCode 键就是这个格式。
    const [history, earnings, financials, consensusReports, knowledge, klines, indexKlines, industry] =
      await Promise.all([
        quote ? loadValuationHistory(quote.code).catch(() => null) : Promise.resolve(null),
        quote ? loadEarnings(quote.id).catch(() => null) : Promise.resolve(null),
        quote ? loadFinancials(quote.id).catch(() => null) : Promise.resolve(null),
        quote ? fetchConsensusReports(quote.code).catch(() => null) : Promise.resolve(null),
        quote ? loadKnowledge(quote.id, userId).catch(() => null) : Promise.resolve(null),
        quote ? loadKlines(quote.id).catch(() => null) : Promise.resolve(null),
        quote ? loadKlines("sh000300").catch(() => null) : Promise.resolve(null),
        quote ? loadIndustry().catch(() => null) : Promise.resolve(null),
      ]);
    const valuation = valuationPosition(history);
    // 一致预期（D1）：东财研报接口直连，失败/没有就降级成 null，估值阶段写缺口
    const consensus = consensusReports ? aggregateConsensus(consensusReports) : null;
    // 行业与产业链（D6 分类 + D5 月度温度计）。分类拿不到就只给分类缺口，
    // 月度拿不到就只给月度缺口——两件事分开写，别混成一句「行业数据缺失」。
    const boardCode = quote && industry ? finestIndustry(industry, quote.id)[0]?.code ?? null : null;
    const boardMonthly = boardCode ? await loadBoardMonthly(boardCode).catch(() => null) : null;
    const report = runResearch({
      quote,
      articles: news.articles,
      valuation,
      earnings,
      financials,
      consensus,
      knowledge,
      klines,
      indexKlines,
      industry,
      boardMonthly,
    });
    // 研判完自动归档（覆盖旧的）——这样下次研判同一只票能核对这次的预警
    if (quote) {
      const reportId = `research-${quote.id}-${Date.now().toString(36)}`;
      await saveKnowledge(knowledgeFromReport(report, reportId, quote, valuation), userId).catch(() => {});
    }
    const evidenceIds = collectEvidence(report.stages).map((e) => e.id);
    // AI 综合。caller 里读档案 + 调 callAI + 记账；任何异常都由 runAiSynthesis 接住
    const ai = await runAiSynthesis(report.stages, report.symbol, report.name, async (prompt) => {
      const cfg = await readAIConfig();
      if (!cfg) throw new Error("没有配置可用的 AI 档案（/ai 页可以配）");
      return callAI(cfg, prompt, { layer: "research", trigger: "manual" });
    }, evidenceIds);

    return { q, quote, articles: news.articles, valuation, why: quote ? null : "找到资讯但没拿到这只票的行情快照", report, ai };
  });

export const Route = createFileRoute("/research/")({
  validateSearch: (search: Record<string, unknown>) => ({ q: qParam(search) }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => runResearchPage({ data: deps.q }),
  // 七阶段 + AI 综合真实耗时 1-2 分钟（2026-10-21 实测 118 秒），同样要给 pending 态。
  pendingComponent: () => (
    <Frame wide>
      <Panel title="个股研判">
        <StateBlock kind="loading" title="七阶段流水线跑证据中" hint="真实耗时约 1-2 分钟，请留在本页等结果。" />
      </Panel>
    </Frame>
  ),
  component: ResearchPage,
});

function ResearchPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [value, setValue] = useState(search.q);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<"structured" | "raw" | "data" | "log">("structured");
  useEffect(() => setValue(search.q), [search.q]);

  // 报告在 loader 里算好（那里还要顺手跑 AI 综合）。q 为空时没有报告。
  const report = data.report ?? runResearch({ quote: data.quote, articles: data.articles, valuation: data.valuation });
  const ai = data.ai;
  // AI 正文里出现的证据 id 只有在账本里真实存在才可点（linkify 内部也校验，双保险）。
  const knownEvidenceIds = new Set(collectEvidence(report.stages).map((e) => e.id));

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveResearchReport({ data: { report, ai } });
      setSaved(res.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame
      wide
      status={{
        label: "证据链",
        // **真实数据**：report.chain.evidence 是引用的证据条数，
        // dangling 是「声称有据可查但那条证据不在账里」的条数——非空要说出来，
        // 这正是「避免黑箱」的红线所在，不能藏。
        value: report
          ? `${report.chain.evidence} 条${report.chain.dangling.length > 0 ? ` · ${report.chain.dangling.length} 条悬空` : ""}`
          : null,
        tone: report && report.chain.dangling.length > 0 ? "warn" : report ? "ok" : "neutral",
      }}
      ornamentContent={
        report ? (
          <span className="text-[11px] tabular-nums">
            {report.stages.length} 个阶段 · {report.gaps.length} 处缺口
            {report.numbersReplaced > 0 ? ` · 换掉 ${report.numbersReplaced} 个数字` : ""}
          </span>
        ) : (
          <span className="text-[11px]">还没有研判结果</span>
        )
      }
    >
      <h1 className="font-display text-xl font-medium tracking-wide">研究</h1>
      <SectionTabs ariaLabel="研究" tabs={RESEARCH_TABS} />
      <Panel
        title="个股研判"
        note={
          <span className="text-xs text-muted">七阶段 · 只给数据和裁决点，不给买卖建议</span>
        }
        action={
          data.q ? (
            <button
              type="button"
              disabled={saving || saved != null}
              onClick={() => void save()}
              className="rounded bg-brand px-2.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-60"
            >
              {saved ? "已存" : saving ? "存…" : "存成报告"}
            </button>
          ) : null
        }
      >
        <div className="p-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate({ to: "/research", search: { q: value.trim() } });
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
              开始研判
            </button>
          </form>
        </div>
      </Panel>

      {!data.q ? (
        <Panel title="还没选股票">
          <StateBlock
            kind="empty"
            title="输入一只股票开始"
            hint="研判按六个固定阶段走完：身份、价格位置、资金、催化剂、估值锚、裁决点。没有的股票或者查不到的字段会明写出来，不会替你猜。"
          />
        </Panel>
      ) : null}

      {data.why && !data.quote ? (
        <Panel title="这一只现在查不到">
          <StateBlock
            kind="error"
            title={data.why}
            hint="行情快照是全市场一起拉的，某一只缺席通常是它在停牌、退市或刚换代码；资讯还能看的话下面照常列。"
          />
        </Panel>
      ) : null}

      {report.blocked > 0 ? (
        <div className="rounded border border-warn/60 bg-warn-soft px-3 py-2 text-xs leading-relaxed text-warn">
          有 {report.blocked} 条结论在生成时被红线拦下并标了位置。赤轨不做投资建议，越线的那几句没有显示原文。
        </div>
      ) : null}

      {/* 引用链自检（P0-3）：每个算出来的数字都能走回它的原始序列。
          dangling 非空 = 有数字声称基于不存在的证据，那是伪装成有据可查，必须大声说。 */}
      {report.chain.calculations > 0 || report.chain.dangling.length > 0 ? (
        <div
          className={
            "rounded border px-3 py-2 text-xs leading-relaxed " +
            (report.chain.dangling.length > 0
              ? "border-warn/60 bg-warn-soft text-warn"
              : "border-line bg-surface text-muted")
          }
        >
          {report.chain.dangling.length > 0
            ? `引用链断裂 ${report.chain.dangling.length} 处：有数字声称基于账里没有的证据。这些数字不该被信。`
            : `引用链：${report.chain.evidence} 条证据 · ${report.chain.calculations} 条计算，无悬空引用。分位数下面的那行小字就是它的来路。`}
        </div>
      ) : null}

      {saved ? (
        <div className="rounded border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
          已存成本机报告（id {saved}）。<Link to="/reports" className="text-accent hover:underline">去「我的报告」看</Link>
          {saveError ? <span className="text-warn"> · {saveError}</span> : null}
        </div>
      ) : null}

      {data.q ? (
        <StepFlow
          stages={report.stages}
          onSelect={() => {
            setTab("structured");
            requestAnimationFrame(() =>
              document.getElementById("research-structured")?.scrollIntoView({ behavior: "smooth", block: "center" }),
            );
          }}
        />
      ) : null}

      {data.q ? (
        <div className="flex flex-col gap-3">
          <div role="tablist" aria-label="研判视图" className="flex flex-wrap gap-1.5">
            {RESEARCH_VIEW_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={
                  "rounded border px-2.5 py-1 text-xs transition " +
                  (tab === t.key ? "border-brand font-medium text-fg" : "border-line text-muted hover:text-fg")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "structured" ? <StructuredView stages={report.stages} gaps={report.gaps} /> : null}
          {tab === "raw" ? <RawInfo articles={data.articles} /> : null}
          {tab === "data" ? <DataCards quote={data.quote} valuation={data.valuation} /> : null}
          {tab === "log" ? <ResearchLog ai={ai} report={report} saved={saved} knownIds={knownEvidenceIds} /> : null}
        </div>
      ) : null}

      <p className="px-1 text-xs leading-relaxed text-muted">
        这一页的七阶段套用 Vibe-Research 的个股研究 SOP，每条结论按四档可信度标注。
        判据都是固定规则，不是模型即兴发挥；它们描述的是过去和现在，不代表未来会重复。
      </p>
    </Frame>
  );
}

/**
 * 跳回证据表里那一行。学 Vibe-Research 的证据回查交互：
 * 正文里的引用不是装饰，点了要落到证据行上。
 * 页面上每个证据行都带同名 id 锚点（见 StageCard 的证据表）。
 */
function scrollToEvidence(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 一个可点的证据引用 chip。 */
function EvidenceRefChip({ id }: { id: string }) {
  return (
    <button
      type="button"
      onClick={() => scrollToEvidence(id)}
      className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-accent transition hover:border-accent hover:bg-brand-soft"
      title="跳到这条证据"
    >
      {id}
    </button>
  );
}

/**
 * AI 正文渲染：把出现的证据 id 切成文本段和引用段，
 * 引用段渲染成可点的小 chip，点回证据表对应行。
 * 未知 id 保持纯文本——不替 AI 伪造可查性。
 */
function LinkifiedText({ text, knownIds }: { text: string; knownIds: ReadonlySet<string> }) {
  const segments = linkifyEvidenceText(text, knownIds);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => scrollToEvidence(seg.id)}
            className="rounded border border-line bg-surface px-1 py-px font-mono text-[11px] text-accent transition hover:border-accent hover:bg-brand-soft"
            title="跳到这条证据"
          >
            {seg.id}
          </button>
        ),
      )}
    </>
  );
}

/* ===== 重设计：Tab + 事实/推断/待验证 三栏（2026-10-26） ===== */

const RESEARCH_VIEW_TABS = [
  { key: "structured", label: "结构化分析" },
  { key: "raw", label: "原始信息" },
  { key: "data", label: "数据卡片" },
  { key: "log", label: "研究日志" },
] as const;

const TIER_LABEL: Record<string, string> = {
  confirmed: "已披露证实",
  inferred: "有依据的推断",
  unverified: "未核实线索",
  refuted: "被反证",
};
const TIER_TONE: Record<string, "brand" | "warn"> = {
  confirmed: "brand",
  inferred: "brand",
  unverified: "warn",
  refuted: "warn",
};

function ColHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-line pb-2">
      <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

/**
 * 把七阶段摊平成三栏：事实（证据+算出数）、推断（结论）、待验证（缺口）。
 * 证据锚点 id 与 collectEvidence 同格式（ev-${stage.id}-${label}），derived 用
 * d.evidenceId；AI 正文里点的引用照样能跳回来。
 */
function StructuredView({ stages, gaps }: { stages: StageResult[]; gaps: string[] }) {
  const facts = stages.flatMap((s) => s.evidence.map((e) => ({ s, e })));
  const derived = stages.flatMap((s) => s.derived.map((d) => ({ s, d })));
  const inferences = stages.flatMap((s) => s.findings.map((f) => ({ s, f })));
  const todos = [
    ...stages.flatMap((s) => s.gaps.map((g) => ({ stage: s.title, g }))),
    ...gaps.map((g) => ({ stage: "", g })),
  ];
  return (
    <Panel id="research-structured" title="结构化分析" note={<span className="text-xs text-muted">事实 · 推断 · 待验证，按七阶段汇总</span>}>
      <div className="grid grid-cols-1 gap-4 p-3 md:grid-cols-3">
        <div>
          <ColHeader label="事实" />
          <div className="mt-2 flex flex-col">
            {facts.length === 0 && derived.length === 0 ? (
              <p className="text-xs text-muted">这一阶段没有可核实的事实。</p>
            ) : null}
            {facts.map(({ s, e }) => (
              <div key={`${s.id}-${e.label}`} id={`ev-${s.id}-${e.label}`} className="scroll-mt-16 border-b border-dashed border-line py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted">{e.label}</span>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-fg">{e.value}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted">{e.source}</div>
              </div>
            ))}
            {derived.map(({ s, d }) => (
              <div key={d.calcId} id={d.evidenceId} className="scroll-mt-16 border-b border-dashed border-line py-2">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="h-3 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
                  <span className="shrink-0 text-muted">{d.label}</span>
                  <span className="font-medium tabular-nums">{d.value}</span>
                  <Tag tone={TIER_TONE[d.tier] ?? "muted"}>{TIER_LABEL[d.tier] ?? d.tier}</Tag>
                </div>
                <code className="pl-[11px] font-mono text-[10px] leading-relaxed text-muted">{d.chain}</code>
              </div>
            ))}
          </div>
        </div>

        <div>
          <ColHeader label="推断" />
          <div className="mt-2 flex flex-col gap-2">
            {inferences.length === 0 ? (
              <p className="text-xs text-muted">这一阶段没有推断结论。</p>
            ) : (
              inferences.map(({ s, f }, i) => (
                <div key={`${s.id}-${i}`} className="flex items-baseline gap-2 text-sm leading-relaxed">
                  <Tag tone={TIER_TONE[f.tier] ?? "muted"}>{TIER_LABEL[f.tier] ?? f.tier}</Tag>
                  <span className="min-w-0 flex-1">{f.text}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <ColHeader label="待验证" />
          <div className="mt-2 flex flex-col gap-1.5">
            {todos.length === 0 ? (
              <p className="text-xs text-muted">这一阶段没有明确的待验证项。</p>
            ) : (
              todos.map(({ stage, g }, i) => (
                <div key={i} className="rounded border border-line bg-surface-2 px-2.5 py-1.5 text-xs leading-relaxed">
                  {stage ? <span className="text-muted">[{stage}] </span> : null}
                  <span className="text-fg">{g}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function RawInfo({ articles }: { articles: StockArticle[] }) {
  if (articles.length === 0) {
    return (
      <Panel title="原始信息">
        <StateBlock kind="empty" title="没有拉到这只票的资讯或公告" hint="资讯接口暂时拉不下来，或这只票近期没有公告。" />
      </Panel>
    );
  }
  const TONE: Record<string, { tone: "up" | "down" | "muted"; label: string }> = {
    good: { tone: "up", label: "利好" },
    bad: { tone: "down", label: "利空" },
    flat: { tone: "muted", label: "中性" },
  };
  return (
    <Panel title={`原始信息 · ${articles.length} 条`} note={<span className="text-xs text-muted">标题用词自动分档，机器读不出反讽</span>}>
      <ul className="divide-y divide-line">
        {articles.map((a) => {
          const t = TONE[a.tone] ?? TONE.flat;
          return (
            <li key={a.id} className="flex items-baseline gap-2 px-3 py-2">
              <span className="w-28 shrink-0 text-[11px] tabular-nums text-muted">{a.time.slice(0, 16)}</span>
              <Tag tone={t.tone}>{t.label}</Tag>
              <span className="min-w-0 flex-1 text-sm">{a.title}</span>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-accent hover:underline">原文</a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function DataCards({ quote, valuation }: { quote: Quote | null; valuation: ValuationPosition | null }) {
  if (!quote) {
    return (
      <Panel title="数据卡片">
        <StateBlock kind="empty" title="没有行情快照" hint="行情接口拉不到这只票，数据卡片无内容。" />
      </Panel>
    );
  }
  const q = quote;
  const cells: { label: string; value: ReactNode; tone?: string }[] = [
    { label: "现价", value: q.price.toFixed(2) },
    { label: "涨跌幅", value: q.chg != null ? `${q.chg > 0 ? "+" : ""}${q.chg.toFixed(2)}%` : "—", tone: pctClass(q.chg) },
    { label: "总市值", value: `${q.cap.toFixed(0)} 亿` },
    { label: "流通市值", value: `${q.floatCap.toFixed(0)} 亿` },
    { label: "换手率", value: `${q.turnover.toFixed(2)}%` },
    { label: "量比", value: q.volRatio.toFixed(2) },
    { label: "振幅", value: `${q.amp.toFixed(2)}%` },
    { label: "市盈率 TTM", value: q.pe != null ? `${q.pe.toFixed(2)} 倍` : "—" },
    { label: "市净率", value: q.pb != null ? `${q.pb.toFixed(2)} 倍` : "—" },
    { label: "近 5 日", value: q.d5 != null ? `${q.d5 > 0 ? "+" : ""}${q.d5.toFixed(2)}%` : "—", tone: pctClass(q.d5) },
    { label: "近 20 日", value: q.d20 != null ? `${q.d20 > 0 ? "+" : ""}${q.d20.toFixed(2)}%` : "—", tone: pctClass(q.d20) },
    { label: "近 60 日", value: q.d60 != null ? `${q.d60 > 0 ? "+" : ""}${q.d60.toFixed(2)}%` : "—", tone: pctClass(q.d60) },
    { label: "今年以来", value: q.ytd != null ? `${q.ytd > 0 ? "+" : ""}${q.ytd.toFixed(2)}%` : "—", tone: pctClass(q.ytd) },
    { label: "主力净流入", value: `${(q.inflow / 1e4).toFixed(2)} 亿` },
    { label: "成交额", value: `${(q.amount / 1e4).toFixed(2)} 亿` },
  ];
  if (valuation) {
    if (valuation.peRank != null) cells.push({ label: "PE 历史分位", value: rankPhrase(valuation.peRank) });
    if (valuation.pbRank != null) cells.push({ label: "PB 历史分位", value: rankPhrase(valuation.pbRank) });
  }
  return (
    <Panel title="数据卡片" note={<span className="text-xs text-muted">行情快照（腾讯/新浪）+ 估值分位（baostock）</span>}>
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
        {cells.map((c) => (
          <div key={c.label} className="bg-surface px-3 py-2">
            <div className="text-xs text-muted">{c.label}</div>
            <div className={`mt-0.5 text-sm font-medium tabular-nums ${c.tone ?? "text-fg"}`}>{c.value}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ResearchLog({ ai, report, saved, knownIds }: { ai: AiSynthesis | null; report: ResearchReport; saved: string | null; knownIds: ReadonlySet<string> }) {
  return (
    <Panel title="研究日志" note={<span className="text-xs text-muted">AI 综合 · 引用链 · 本轮元数据</span>}>
      <div className="flex flex-col gap-3 p-3">
        {ai && ai.status !== "skipped" ? (
          <section className={"rounded border px-3 py-2.5 " + (ai.status === "ok" ? "border-line bg-brand-soft" : ai.status === "refused" ? "border-warn/60 bg-warn-soft" : "border-line bg-surface")}>
            <div className="flex items-baseline gap-2">
              <span className="h-4 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
              <h2 className="text-sm font-medium">AI 综合</h2>
              <span className="text-xs text-muted">{ai.status === "ok" ? `基于上面的证据 · ${(ai.ms / 1000).toFixed(1)} 秒` : "本轮没有 AI 产出"}</span>
            </div>
            {ai.status === "ok" ? (
              <>
                <p className="mt-1.5 text-sm leading-relaxed">
                  <LinkifiedText text={ai.text ?? ""} knownIds={knownIds} />
                </p>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10px] text-muted">
                  {ai.chain ? <code className="font-mono">{ai.chain}</code> : null}
                  {ai.numbersReplaced > 0 ? (
                    <span className="text-warn">{ai.numbersReplaced} 个数字在证据里找不到出处，已换成（略※）</span>
                  ) : null}
                </div>
                {ai.refs.length > 0 ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-muted">引用证据：</span>
                    {ai.refs.map((id) => (
                      <EvidenceRefChip key={id} id={id} />
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <p className={"mt-1.5 text-xs leading-relaxed " + (ai.status === "refused" ? "text-warn" : "text-muted")}>
                {ai.why}
                {ai.status === "failed" ? "（上面六个阶段是规则推出来的，与 AI 无关）" : ""}
              </p>
            )}
          </section>
        ) : (
          <p className="text-xs text-muted">本轮跳过 AI 综合（未配置或已关闭）。</p>
        )}

        <div className="rounded border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>阶段 {report.stages.length}</span>
            <span>缺口 {report.gaps.length}</span>
            <span>被红线拦下 {report.blocked}</span>
            <span>数字换掉 {report.numbersReplaced}</span>
            <span>
              引用链 {report.chain.evidence} 证据 / {report.chain.calculations} 计算
              {report.chain.dangling.length > 0 ? ` · ${report.chain.dangling.length} 悬空` : " · 无悬空"}
            </span>
          </div>
          {saved ? (
            <div className="mt-1">
              已存报告（id {saved}）。<Link to="/reports" className="text-accent hover:underline">去「我的报告」看</Link>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

/**
 * 七步研判流程条（效果图签名元素）。完全由真实 report.stages 派生，
 * 不编任何「当前步」——每步状态按该阶段 evidence+findings+derived 与 gaps 算：
 * 有数据无缺口=已核验，有数据有缺口=有缺口，无数据有缺口=缺数据，全空=未触及。
 * active 指向第一个还没 done 的阶段（分析前沿）。点任一步跳到对应阶段卡
 * （StageCard 根挂了 id=stage-<id> 锚点）。
 */
function StepFlow({ stages, onSelect }: { stages: StageResult[]; onSelect?: () => void }) {
  if (stages.length === 0) return null;
  const statusOf = (s: StageResult): "done" | "partial" | "gap" | "empty" => {
    const hasContent = s.evidence.length + s.findings.length + s.derived.length > 0;
    const hasGap = s.gaps.length > 0;
    if (hasContent && !hasGap) return "done";
    if (hasContent && hasGap) return "partial";
    if (!hasContent && hasGap) return "gap";
    return "empty";
  };
  const statuses = stages.map(statusOf);
  const activeIdx = statuses.findIndex((st) => st !== "done");
  const dot: Record<string, string> = { done: "bg-down", partial: "bg-warn", gap: "bg-up", empty: "bg-muted" };
  const label: Record<string, string> = { done: "已核验", partial: "有缺口", gap: "缺数据", empty: "未触及" };
  const ring: Record<string, string> = {
    done: "border-down/50 text-down",
    partial: "border-warn/50 text-warn",
    gap: "border-up/50 text-up",
    empty: "border-line text-muted",
  };
  const jump = (_id: string) => {
    onSelect?.();
    document.getElementById("research-structured")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <nav className="flex flex-wrap items-stretch gap-1.5 rounded border border-line bg-surface p-2.5" aria-label="研判流程">
      {stages.map((s, i) => {
        const st = statuses[i];
        const isActive = i === activeIdx;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => jump(s.id)}
            className={
              "flex min-w-[92px] flex-1 flex-col gap-1 rounded border px-2.5 py-1.5 text-left transition hover:bg-surface-2 " +
              ring[st] +
              (isActive ? " ring-1 ring-brand" : "")
            }
          >
            <span className="flex items-center gap-1.5">
              <span className={"h-1.5 w-1.5 rounded-full " + dot[st]} aria-hidden />
              <span className="text-[10px] tabular-nums text-muted">{String(i + 1).padStart(2, "0")}</span>
            </span>
            <span className="text-xs font-medium leading-tight">{s.title}</span>
            <span className="text-[10px]">{label[st]}</span>
          </button>
        );
      })}
    </nav>
  );
}

// 2026-10-26：竖向可折叠阶段卡（StageCard）改为「Tab + 事实/推断/待验证 三栏」
// （StructuredView），对齐重设计效果图。证据锚点 ev-${stage.id}-${label} 与
// derived 的 id=${d.evidenceId} 仍在 StructuredView 里保留，AI 跳转不失效。
