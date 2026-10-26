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

import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Frame } from "@/components/screener/nav";
import { RESEARCH_TABS, SectionTabs } from "@/components/section-tabs";
import { CollapsibleSection } from "@/components/collapsible";
import { Panel, Table, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { knowledgeFromReport, runResearch, type StageResult } from "@/lib/market/research";
import { collectEvidence, runAiSynthesis } from "@/lib/market/research-ai";
import { linkifyEvidenceText } from "@/lib/market/evidence";
import { loadEarnings } from "@/lib/market/earnings-store";
import { loadFinancials } from "@/lib/market/financials-store";
import { fetchConsensusReports } from "@/lib/market/consensus-store";
import { aggregateConsensus } from "@/lib/market/consensus";
import { loadKnowledge, saveKnowledge } from "@/lib/market/knowledge-store";
import { loadKlines } from "@/lib/market/kline-store";
import { loadBoardMonthly, loadIndustry } from "@/lib/market/industry-store";
import { finestIndustry } from "@/lib/market/industry";
import { loadValuationHistory, valuationPosition } from "@/lib/market/pe-history";
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

      {/* AI 综合。四种状态都明说，不许把模板结论说成 AI 说的——
          那比没有 AI 更糟。 */}
      {ai && ai.status !== "skipped" ? (
        <section
          className={
            "rounded border px-3 py-2.5 " +
            (ai.status === "ok"
              ? "border-line bg-brand-soft"
              : ai.status === "refused"
                ? "border-warn/60 bg-warn-soft"
                : "border-line bg-surface")
          }
        >
          <div className="flex items-baseline gap-2">
            <span className="h-4 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
            <h2 className="text-sm font-medium">AI 综合</h2>
            <span className="text-xs text-muted">
              {ai.status === "ok" ? `基于上面的证据 · ${(ai.ms / 1000).toFixed(1)} 秒` : "本轮没有 AI 产出"}
            </span>
          </div>
          {ai.status === "ok" ? (
            <>
              <p className="mt-1.5 text-sm leading-relaxed">
                <LinkifiedText text={ai.text ?? ""} knownIds={knownEvidenceIds} />
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
      ) : null}

      {saved ? (
        <div className="rounded border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
          已存成本机报告（id {saved}）。<Link to="/reports" className="text-accent hover:underline">去「我的报告」看</Link>
          {saveError ? <span className="text-warn"> · {saveError}</span> : null}
        </div>
      ) : null}

      {report.stages.map((stage, index) => (
        <StageCard key={stage.id} stage={stage} index={index} hidden={!data.quote && stage.evidence.length === 0} />
      ))}

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

/**
 * 一个阶段。
 *
 * 顺序：问题（已经有标题右侧那句）→ 证据表 → 结论 → 缺口。
 * 缺口放在最后一行但**不是灰字小到看不见**：它是「这一段能不能信」的一部分，
 * 藏起来等于让读者以为都查到了。
 */
function StageCard({ stage, index, hidden }: { stage: StageResult; index: number; hidden: boolean }) {
  if (hidden) return null;
  // 2026-10-16 用户要求页面可折叠：七个阶段默认只展开第一段，其余点开看。
  // 折叠状态记在 localStorage，看过哪段保持哪段。
  return (
    <CollapsibleSection
      storageKey={`ch-collapse-research-${stage.id}`}
      defaultOpen={index === 0}
      header={
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xs font-normal text-muted tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          <span className="text-sm font-medium">{stage.title}</span>
          <span className="text-xs text-muted">{stage.question}</span>
        </span>
      }
    >
      {stage.evidence.length > 0 ? (
        <Table caption={`${stage.title}阶段的证据`}>
          <thead>
            <tr>
              <th className={thClass("text-left")}>项</th>
              <th className={thClass("text-left")}>值</th>
              <th className={thClass("text-left")}>来源</th>
            </tr>
          </thead>
          <tbody>
            {stage.evidence.map((row, i) => (
              // id 与 collectEvidence（research-ai.ts）给 AI 的行内 id 同格式：
              // AI 正文里引用 ev-xxx 时才能跳回这一行。
              <tr key={`${row.label}-${i}`} id={`ev-${stage.id}-${row.label}`} className="border-t border-line scroll-mt-16">
                <td className={tdClass("text-left text-muted")}>{row.label}</td>
                <td className={tdClass("text-left text-fg")}>{row.value}</td>
                <td className={tdClass("text-left text-xs text-muted")}>{row.source}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      {stage.findings.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
          {stage.findings.map((finding, i) => (
            <div key={i} className="flex items-baseline gap-2 text-sm leading-relaxed">
              <Tag tone={finding.tier === "未核实线索" ? "warn" : "brand"}>{finding.tier}</Tag>
              <span className="min-w-0 flex-1">{finding.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 算出来的数字（带引用链）。只有经过运算的才配拥有它——直接读来的数本身就是证据。 */}
      {stage.derived.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
          {stage.derived.map((d) => (
            <div key={d.calcId} id={d.evidenceId} className="flex flex-col gap-0.5 scroll-mt-16">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="h-3 w-[3px] shrink-0 rounded-full bg-brand" aria-hidden />
                <span className="shrink-0 text-muted">{d.label}</span>
                <span className="font-medium tabular-nums">{d.value}</span>
                <Tag tone="brand">{d.tier}</Tag>
              </div>
              <code className="pl-[11px] font-mono text-[10px] leading-relaxed text-muted">{d.chain}</code>
            </div>
          ))}
        </div>
      ) : null}

      {stage.gaps.length > 0 ? (
        <div className="border-t border-line bg-warn-soft/40 px-3 py-2">
          <div className="text-xs text-warn">这一段缺数据</div>
          <ul className="mt-1 flex flex-col gap-1">
            {stage.gaps.map((gap, i) => (
              <li key={i} className="text-xs leading-relaxed text-muted">
                · {gap}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
