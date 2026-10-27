/**
 * 这个文件是干什么的：
 * 「因子」区的「6 关判决」子页（/factors/gates）。预登记 6 关的总表：
 * 点因子名就地展开五档形状 + 每关判据原话 + 跑之前写下的方向理由。
 *
 * 你需要知道的：
 * - 2026-10-21 由因子整页拆出（原来是本地状态的页内 tab），批次参数走地址栏。
 * - 「—」表示这一关这次没做或没记，不是没通过。
 */

import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { StateBlock } from "@/components/state-block";
import { getFactorRuns } from "@/lib/market/quotes.functions";
import { factorRows } from "@/lib/market/factors-view";
import { FactorGateTable } from "@/components/screener/factor-gate-table";
import type { FactorRunsPayload } from "@/lib/market/factor-runs-file";
import {
  BatchPicker,
  FactorSectionTabs,
  messageOf,
  parseBatch,
  RERUN_HINT,
  Section,
} from "@/components/factor-sections";

export const Route = createFileRoute("/factors/gates")({
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
  component: FactorGatesPage,
});

function FactorGatesPage() {
  const { runs } = Route.useLoaderData();
  const rows = useMemo(() => factorRows(runs.batch?.rows ?? []), [runs.batch]);

  return (
    <Frame wide aside="因子发掘 · 6 关判决">
      <FactorSectionTabs />
      <BatchPicker runs={runs} current={runs.batchIndex} to="/factors/gates" />
      <Section
        title="6 关判决总表"
        hint={`点因子名就地展开：五档形状 + 每关判据原话 + 跑之前写下的方向理由。t 日收盘排序，次日开盘等权买入、持有 ${runs.batch?.n ?? "?"} 天后按收盘卖出，收益减同期全池。「—」表示这一关这次没做或没记，不是没通过。`}
      >
        {rows.length > 0 ? (
          <div>
            <FactorGateTable rows={rows} />
            <p className="px-3 py-2 text-[11px] leading-relaxed text-muted">
              六关判什么：G1 单调且方向符合预注册（Spearman ≥0.8）· G2 |t|≥2 · G3 前后两段同号且各 |t|≥1 ·
              G4 换一批不重叠的股票仍同号且 |t|≥2 · G5 Bonferroni 按已测总数 N 收紧临界 · G6 顶档被可交易闸挡掉 ≤50%。
            </p>
            <div className="border-t border-line px-3 py-2">
              <p className="text-[11px] font-medium text-muted">败在一关 = 得了一种病，对症下药才值得再试：</p>
              <ul className="mt-1 space-y-0.5 text-[11px] leading-relaxed text-muted">
                <li>· G1 形状不符——五档形状和当初登记的方向对不上；要改就按真实形状换个新 id 重新预登记，旧记录留档。</li>
                <li>· G2 t 不够——|t|&lt;2 等于没测出来，大概率是噪声，别当回事。</li>
                <li>· G3 时段翻号——前半段后半段结论相反，换个行情环境就亏钱，最致命，别抱幻想。</li>
                <li>· G4 换样本死——换批股票就不成立，只是这批票的巧合。</li>
                <li>· G5 校正后不显著——测的因子多了，运气成分被 Bonferroni 挤掉，降回候选。</li>
                <li>· G6 顶档被挡——最好的那档实际买不进去，纸上富贵；闸门对应真实下单约束，不许调低。</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="px-3.5 py-4">
            <StateBlock kind="empty" title="没有可展示的判决" hint={runs.missing ?? RERUN_HINT} />
          </div>
        )}
      </Section>
    </Frame>
  );
}
