/**
 * 这个文件是干什么的：
 * 「AI 管理」区的「Token 用量」子页（/ai/usage）。每次调 AI 自动记账：
 * 输入/输出/总 tokens、耗时、成败、哪条链路（因子/策略/测试）烧的，
 * 外加按现价估算的费用。
 *
 * 你需要知道的：
 * - 2026-11-06 按 AI 区新效果图重排：统计卡带「较上 7 天」真实差值（从用量账
 *   自己算，没有就写没有）；近 7 天堆叠面积图按输入/输出两段手绘 SVG；
 *   调用明细带模型/链路/结果筛选和翻页。效果图里按小时的 toggle 没画——
 *   夜里没调用，小时粒度只会画出一排零柱，是假信息。
 * - 接口不返回 usage 就记 0，不瞎编；历史账永不改口径，估算按现行参考价另算。
 */

import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Table, tdClass, thClass } from "@/components/terminal";
import { AiStat, StackedArea } from "@/components/ai-kit";
import { getAIUsage } from "@/lib/market/quotes.functions";
import { AISectionTabs, Section, type UsagePayload } from "@/components/ai-panels";
import type { AIUsageEntry } from "@/lib/market/ai-usage";
import { PixelHeader } from "@/components/pixel-header";
import { PixelSummary } from "@/components/pixel-summary";

export const Route = createFileRoute("/ai/usage")({
  loader: async () => {
    const usage = await getAIUsage().catch((): UsagePayload => ({ allowed: false, entries: [], stats: null }));
    // 日期窗口的基准时刻随 loader 序列化：SSR 与 hydration 用同一个值，
    // 不在 render 里读系统时钟（否则跨日边界会 #418）。
    return { usage, serverNow: Date.now() };
  },
  component: AIUsagePage,
});

const PAGE_SIZE = 20;

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}
function fmtCost(n: number): string {
  return `¥${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** 上海时区的日期串（账都按上海日聚合）。now 由 loader 下发，不在 render 里读系统时钟。 */
function shanghaiDate(offsetDays: number, now: number): string {
  return new Date(now + 8 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** 一个时间窗的汇总：调用/成功/输入/输出/费用/耗时。 */
function windowSum(entries: AIUsageEntry[], fromIso: string, toIso: string) {
  const rows = entries.filter((e) => e.at >= fromIso && e.at < toIso);
  const ok = rows.filter((e) => e.ok).length;
  const prompt = rows.reduce((a, e) => a + e.promptTokens, 0);
  const completion = rows.reduce((a, e) => a + e.completionTokens, 0);
  const cost = rows.reduce((a, e) => a + e.cost, 0);
  const ms = rows.reduce((a, e) => a + e.ms, 0);
  return { calls: rows.length, ok, prompt, completion, cost, ms, rate: rows.length > 0 ? Math.round((ok / rows.length) * 100) : null };
}

function AIUsagePage() {
  const { usage, serverNow } = Route.useLoaderData();
  const [range, setRange] = useState<7 | 30>(7);
  const [modelFilter, setModelFilter] = useState("all");
  const [layerFilter, setLayerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);

  const entries = usage.entries;
  const models = useMemo(() => [...new Set(entries.map((e) => e.model))].sort(), [entries]);
  const layers = useMemo(() => [...new Set(entries.map((e) => e.layer))], [entries]);

  // 当前窗 vs 上一窗（真实差值）
  const curFrom = shanghaiDate(-(range - 1), serverNow);
  const cur = useMemo(() => windowSum(entries, `${curFrom}T00:00:00`, `${shanghaiDate(1, serverNow)}T00:00:00`), [entries, curFrom, serverNow]);
  const prev = useMemo(() => windowSum(entries, `${shanghaiDate(-(range * 2 - 1), serverNow)}T00:00:00`, `${curFrom}T00:00:00`), [entries, curFrom, range, serverNow]);
  const delta = (a: number, b: number): string | null =>
    b > 0 ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}% 较上${range}天` : a > 0 ? `新增（上${range}天为 0）` : null;
  const avgMs = (w: { calls: number; ms: number }): number | null => (w.calls > 0 ? Math.round(w.ms / w.calls) : null);

  // 按天堆叠（输入/输出），窗口随 range
  const days = useMemo(() => {
    const list: string[] = [];
    for (let i = range - 1; i >= 0; i--) list.push(shanghaiDate(-i, serverNow));
    return list;
  }, [range, serverNow]);
  const byDay = useMemo(() => {
    const map = new Map<string, { p: number; c: number }>();
    for (const e of entries) {
      const day = new Date(new Date(e.at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
      const m = map.get(day) ?? { p: 0, c: 0 };
      m.p += e.promptTokens;
      m.c += e.completionTokens;
      map.set(day, m);
    }
    return map;
  }, [entries]);

  // 按模型聚合（全历史，和统计卡口径分开）
  const byModel = useMemo(() => {
    const map = new Map<string, { calls: number; ok: number; tokens: number; ms: number; cost: number }>();
    for (const e of entries) {
      const m = map.get(e.model) ?? { calls: 0, ok: 0, tokens: 0, ms: 0, cost: 0 };
      m.calls += 1;
      if (e.ok) m.ok += 1;
      m.tokens += e.totalTokens;
      m.ms += e.ms;
      m.cost += e.cost;
      map.set(e.model, m);
    }
    return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  }, [entries]);
  const maxModelTokens = Math.max(...byModel.map(([, m]) => m.tokens), 1);

  // 明细筛选 + 翻页
  const filtered = useMemo(() => {
    const rows = [...entries]
      .filter((e) => (modelFilter === "all" ? true : e.model === modelFilter))
      .filter((e) => (layerFilter === "all" ? true : e.layer === layerFilter))
      .filter((e) => (statusFilter === "all" ? true : statusFilter === "ok" ? e.ok : !e.ok))
      .reverse();
    return rows;
  }, [entries, modelFilter, layerFilter, statusFilter]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (!usage.allowed) {
    return (
      <Frame wide aside="AI 管理 · Token 用量">
        <AISectionTabs />
        <p className="rounded border border-line bg-surface px-3.5 py-3 text-xs text-muted">只有主人账号能看用量监控。</p>
      </Frame>
    );
  }

  const s = usage.stats;
  const fmt = fmtTokens;
  const fmtC = fmtCost;
  const layerName = (l: string): string => (l === "factor" ? "因子" : l === "strategy" ? "策略" : l === "genome" ? "基因组" : l === "test" ? "测试" : l === "agent" ? "诊断" : l);

  return (
    <Frame wide aside="AI 管理 · Token 用量">
    <PixelHeader label="AI // USAGE" meta="调用与花费 · 每轮多少 token、多少钱" />
    <PixelSummary
      label="AI // USAGE · TOTALS"
      note={`账本 ${entries.length} 条 · 接口不返回 usage 就记 0`}
      stats={[
        { label: "累计 token", value: s?.totalTokens != null ? fmt(s.totalTokens) : null, tone: "brand", hero: true },
        { label: "累计费用", value: s?.totalCost != null ? fmtC(s.totalCost) : null },
        { label: "调用次数", value: s?.okCalls ?? entries.length, hint: "成功" },
        { label: "窗口内调用", value: cur?.calls ?? null, hint: `近 ${range} 天` },
      ]}
    />
      <AISectionTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="font-display text-xl font-medium tracking-wide">Token 用量</h1>
          <p className="mt-0.5 text-xs text-muted">
            监控 AI 调用的 token 消耗、费用与性能。账本共 {entries.length} 条，接口不返回 usage 就记 0，不瞎编。
          </p>
        </div>
        <div className="flex gap-1.5">
          {([7, 30] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRange(r);
                setPage(0);
              }}
              className={
                "rounded-lg border px-3 py-1 text-xs transition " +
                (range === r ? "border-ai-line bg-ai-soft text-ai" : "border-line text-muted hover:text-fg")
              }
            >
              近 {r} 天
            </button>
          ))}
        </div>
      </div>

      {/* 统计卡：当前窗 vs 上一窗的真实差值 */}
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
        <AiStat label="总调用" value={cur.calls} sub={delta(cur.calls, prev.calls)} bars={days.map((day) => byDay.get(day)?.p ?? 0)} />
        <AiStat label="成功率" value={cur.rate != null ? `${cur.rate}%` : "—"} sub={cur.rate != null && prev.rate != null ? `上${range}天 ${prev.rate}%` : `${cur.ok} 次成功`} />
        <AiStat label="输入 Token" value={fmt(cur.prompt)} sub={delta(cur.prompt, prev.prompt)} />
        <AiStat label="输出 Token" value={fmt(cur.completion)} sub={delta(cur.completion, prev.completion)} />
        <AiStat
          label="费用（已计价）"
          value={cur.cost > 0 ? fmtC(cur.cost) : "无快照"}
          sub={s && s.pricedCalls > 0 ? `${s.pricedCalls} 次填过价` : "历史调用都没填价"}
        />
        <AiStat
          label="平均耗时"
          value={avgMs(cur) != null ? `${((avgMs(cur) as number) / 1000).toFixed(1)}s` : "—"}
          sub={avgMs(prev) != null ? `上${range}天 ${((avgMs(prev) as number) / 1000).toFixed(1)}s` : undefined}
        />
      </div>

      <div className="mt-3 grid items-start gap-3 xl:grid-cols-[1fr_360px]">
        {/* 近 7/30 天堆叠面积 */}
        <Section id="usage-trend" title={`近 ${range} 天 Token 用量`} hint="按上海日聚合；输入 = prompt，输出 = completion。">
          <div className="px-3.5 py-3">
            <StackedArea
              series={[
                { name: "输入 Token", values: days.map((day) => byDay.get(day)?.p ?? 0) },
                { name: "输出 Token", values: days.map((day) => byDay.get(day)?.c ?? 0) },
              ]}
              labels={days.map((day) => day.slice(5))}
            />
          </div>
        </Section>

        {/* 按模型 */}
        <Section id="usage-models" title="按模型" hint="全历史求和；占比按总 token。">
          {byModel.length > 0 ? (
            <ul className="divide-y divide-line">
              {byModel.map(([model, m]) => (
                <li key={model} className="px-3.5 py-2">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-fg" title={model}>
                      {model}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {fmt(m.tokens)} · {Math.round((m.tokens / Math.max(s?.totalTokens ?? 1, 1)) * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-ai" style={{ width: `${Math.max((m.tokens / maxModelTokens) * 100, 2)}%` }} />
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">
                    {m.calls} 次 · 成功率 {Math.round((m.ok / m.calls) * 100)}% · 平均 {(m.ms / m.calls / 1000).toFixed(1)}s
                    {m.cost > 0 ? ` · ${fmtC(m.cost)}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3.5 py-3 text-xs text-muted">还没有调用记录。</p>
          )}
        </Section>
      </div>

      {/* 调用明细 */}
      <Section
        id="usage-detail"
        title="调用明细"
        hint="时间正序翻页；链路 = 哪条闭环烧的。费用是调用时的单价快照，没填价记 0 不瞎编。"
      >
        <div className="flex flex-wrap gap-2 border-b border-line px-3.5 py-2">
          <select
            value={modelFilter}
            onChange={(e) => {
              setModelFilter(e.target.value);
              setPage(0);
            }}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
            aria-label="按模型筛选"
          >
            <option value="all">全部模型</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={layerFilter}
            onChange={(e) => {
              setLayerFilter(e.target.value);
              setPage(0);
            }}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
            aria-label="按链路筛选"
          >
            <option value="all">全部链路</option>
            {layers.map((l) => (
              <option key={l} value={l}>
                {layerName(l)}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(0);
            }}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg"
            aria-label="按结果筛选"
          >
            <option value="all">全部状态</option>
            <option value="ok">成功</option>
            <option value="fail">失败</option>
          </select>
          <span className="ml-auto self-center text-[12px] text-muted tabular-nums">共 {filtered.length} 条</span>
        </div>
        <div className="px-3.5 py-3">
          {pageRows.length > 0 ? (
            <Table className="data-table" caption="AI 调用明细：token 数来自接口响应的 usage 字段">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass()}>时间</th>
                  <th className={thClass()}>链路</th>
                  <th className={thClass()}>模型</th>
                  <th className={thClass()}>输入</th>
                  <th className={thClass()}>输出</th>
                  <th className={thClass()}>费用</th>
                  <th className={thClass()}>耗时</th>
                  <th className={thClass()}>结果</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-b-0">
                    <td data-l="时间" className="px-2.5 py-1.5 whitespace-nowrap text-[12px] text-muted">
                      {e.at.slice(5, 16).replace("T", " ")}
                    </td>
                    <td data-l="链路" className="px-2.5 py-1.5 text-[12px] text-muted">
                      {layerName(e.layer)}
                      {e.trigger === "auto" ? "·自动" : ""}
                    </td>
                    <td data-l="模型" className="max-w-[16ch] truncate px-2.5 py-1.5 font-mono text-[12px] text-muted" title={e.model}>
                      {e.model}
                    </td>
                    <td data-l="输入" className="px-2.5 py-1.5 text-right text-[12px] tabular-nums">
                      {e.promptTokens.toLocaleString()}
                    </td>
                    <td data-l="输出" className="px-2.5 py-1.5 text-right text-[12px] tabular-nums">
                      {e.completionTokens.toLocaleString()}
                    </td>
                    <td data-l="费用" className="px-2.5 py-1.5 text-right text-[12px] tabular-nums">
                      {e.cost > 0 ? fmtC(e.cost) : "—"}
                    </td>
                    <td data-l="耗时" className="px-2.5 py-1.5 text-right text-[12px] tabular-nums text-muted">
                      {(e.ms / 1000).toFixed(1)}s
                    </td>
                    <td data-l="结果" className={`px-2.5 py-1.5 text-[12px] ${e.ok ? "text-up" : "text-down"}`} title={e.error}>
                      {e.ok ? "成功" : e.error ? `失败：${e.error.length > 36 ? `${e.error.slice(0, 36)}…` : e.error}` : "失败"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="py-2 text-xs text-muted">这个筛选下没有记录。</p>
          )}
          {pages > 1 ? (
            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted">
              <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded border border-line px-2 py-0.5 disabled:opacity-40">
                上一页
              </button>
              <span className="tabular-nums">
                {page + 1} / {pages}
              </span>
              <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded border border-line px-2 py-0.5 disabled:opacity-40">
                下一页
              </button>
            </div>
          ) : null}
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            已计价 = 调用时档案里的单价快照 × 实际 tokens，历史账永不改口径；估算 = 没快照的历史账按现行参考价补算，仅供参考。
            DeepSeek 高峰时段（北京时间工作日 09:00-12:00、14:00-18:00）实付为估算的 2 倍，命中缓存会更便宜——表按保守口径计。
          </p>
        </div>
      </Section>
    </Frame>
  );
}
