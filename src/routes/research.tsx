/**
 * 这个文件是干什么的：
 * 「个股研判」页。学 Vibe-Research 的 company-research 六阶段 SOP：输入一只股票，
 * 按六个固定阶段把「知道什么、凭什么知道、还不知道什么」分开摆出来。
 *
 * 你需要知道的（纪律）：
 * - **这一页不给买卖建议**。结论只在四类里说话：数据、分析框架、情景概率、裁决点
 *   （red-line.ts 的 ALLOWED_OUTPUTS）。流水线自己的模板产出也过一次红线，由测试钉住。
 * - 每一阶段带一个「缺什么」的块。拿不到的数据写缺口，**不许补 0 或留白**。
 * - 看好处的四档可信度跟着每条结论显示，读者知道自己信的是数据还是推断。
 */

import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Table, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { runResearch, type StageResult } from "@/lib/market/research";
import { getSymbolNews, getUniverse } from "@/lib/market/quotes.functions";
import type { Quote } from "@/lib/market/types";
import type { StockArticle } from "@/lib/market/news";

/**
 * 研判页路由。地址栏里的 q 是搜索词。
 *
 * 报价要从全市场快照里捞：`getSymbolNews` 只给回资讯和一个带涨跌幅的命中项，
 * 研判要的 PE / PB / d60 那些只有 Quote 里有，所以两个接口一起拉。
 * 两个都拉失败时降级成「这只票现在查不到」，不让整页打不开。
 */
export const Route = createFileRoute("/research")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q.trim().slice(0, 20) : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    if (!deps.q) return { q: "", quote: null, articles: [] as StockArticle[], why: null as string | null };
    const [news, uni] = await Promise.all([
      getSymbolNews({ data: { q: deps.q } }).catch(() => null),
      getUniverse({ data: { refresh: false } }).catch(() => null),
    ]);
    if (!news) return { q: deps.q, quote: null, articles: [] as StockArticle[], why: "资讯接口暂时拉不下来" };
    const quote: Quote | null = uni?.quotes.find((row) => row.id === news.picked?.id) ?? null;
    return { q: deps.q, quote, articles: news.articles, why: quote ? null : "找到资讯但没拿到这只票的行情快照" };
  },
  component: ResearchPage,
});

function ResearchPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [value, setValue] = useState(search.q);
  useEffect(() => setValue(search.q), [search.q]);

  // 报告由 loader 的数据现算：research.ts 是纯函数，页面只负责画。
  const report = runResearch({ quote: data.quote, articles: data.articles });

  return (
    <Frame wide>
      <Panel
        title="个股研判"
        note={<span className="text-xs text-muted">六阶段 · 只给数据和裁决点，不给买卖建议</span>}
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

      {report.stages.map((stage, index) => (
        <StageCard key={stage.id} stage={stage} index={index} hidden={!data.quote && stage.evidence.length === 0} />
      ))}

      <p className="px-1 text-xs leading-relaxed text-muted">
        这一页的六阶段套用 Vibe-Research 的个股研究 SOP，每条结论按四档可信度标注。
        判据都是固定规则，不是模型即兴发挥；它们描述的是过去和现在，不代表未来会重复。
      </p>
    </Frame>
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
  return (
    <Panel
      id={`stage-${stage.id}`}
      title={
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-normal text-muted tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          {stage.title}
        </span>
      }
      note={<span className="text-xs text-muted">{stage.question}</span>}
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
              <tr key={`${row.label}-${i}`} className="border-t border-line">
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
    </Panel>
  );
}
