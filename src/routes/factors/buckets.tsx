/**
 * 这个文件是干什么的：
 * 「因子」区的「分档明细」子页（/factors/buckets）。各因子五档平均超额
 * 一张大表——看形状比看单个数字重要：单调才算数。
 *
 * 你需要知道的：
 * - 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab），批次参数走地址栏。
 * - 每一档是这一档所有票未来 N 天收益减去同期全池等权的平均——是超额，不是收益。
 */

import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { Table, tdClass, thClass, pctClass } from "@/components/terminal";
import { signedPct } from "@/lib/market/format";
import { getFactorRuns } from "@/lib/market/quotes.functions";
import { factorRows } from "@/lib/market/factors-view";
import type { FactorRunsPayload } from "@/lib/market/factor-runs-file";
import {
  BatchPicker,
  FactorSectionTabs,
  messageOf,
  parseBatch,
  RERUN_HINT,
  Section,
} from "@/components/factor-sections";

export const Route = createFileRoute("/factors/buckets")({
  validateSearch: (search: Record<string, unknown>) => ({ batch: parseBatch(search) }),
  loaderDeps: ({ search }) => ({ batch: search.batch }),
  loader: async ({ deps }) => {
    const runs = await getFactorRuns({ data: { batch: deps.batch } }).catch(
      (e: unknown): FactorRunsPayload => ({
        batch: null,
        batches: [],
        batchIndex: -1,
        badLines: 0,
        missing: messageOf(e),
      }),
    );
    return { runs };
  },
  component: FactorBucketsPage,
});

function FactorBucketsPage() {
  const { runs } = Route.useLoaderData();
  const rows = useMemo(() => factorRows(runs.batch?.rows ?? []), [runs.batch]);

  return (
    <Frame aside="因子发掘 · 分档明细">
      <FactorSectionTabs />
      <BatchPicker runs={runs} current={runs.batchIndex} to="/factors/buckets" />
      <Section
        title="分档均值明细"
        hint={`每一档是这一档所有票未来 ${runs.batch?.n ?? "?"} 天收益减去同期全池等权的平均——是超额，不是收益。看形状比看单个数字重要：单调才算数。`}
      >
        {rows.length > 0 ? (
          <Table className="data-table" caption="各因子五档平均超额，从因子值最低档到最高档">
            <thead>
              <tr className="border-b border-line">
                <th className={thClass("text-left")}>因子</th>
                {[1, 2, 3, 4, 5].map((i) => (
                  <th key={i} className={thClass()}>
                    档{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-b-0">
                  <td data-l="因子" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
                    <span className="font-medium">{row.name}</span>
                    <span className="ml-1.5 text-[11px] text-muted">{row.category}</span>
                  </td>
                  {row.bucketMeans.map((v, i) => (
                    <td key={i} data-l={`档${i + 1}`} className={tdClass(pctClass(v * 100))}>
                      {signedPct(v * 100)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有分档数据" hint={runs.missing ?? RERUN_HINT} />
          </div>
        )}
      </Section>
    </Frame>
  );
}
