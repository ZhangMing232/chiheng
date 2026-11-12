/**
 * 这个文件是干什么的：
 * 「因子」区（/factors 下）各子页面共用的外壳：区块 Section（口径说明在标题
 * 正下方，不用 Panel——它的 note 在右侧）、二级 tab 定义、loader 兜底工具和
 * 重跑命令文案。
 *
 * 你需要知道的：
 * - 2026-10-21 因子页从「本地状态的页内 tab」改成真实子页面（/factors/ 结论、
 *   /factors/gates 6 关判决、/factors/buckets 分档明细、/factors/attrib 缩量归因、
 *   /factors/flow 资金流探路、/factors/baseline 基线原文），刷新、书签都落在具体子页。
 * - 本文件不含 loader 和路由；数据在各子页 loader 里拉。
 */

import type { ReactNode } from "react";
import { SectionTabs } from "@/components/section-tabs";
import { useNavigate } from "@tanstack/react-router";
import type { FactorRunsPayload } from "@/lib/market/factor-runs-file";

/** 这一区统一的二级 tab：/factors 下所有子页面共用，增删子页只改这里。 */
export function FactorSectionTabs() {
  return (
    <SectionTabs
      ariaLabel="因子发掘"
      tabs={[
        { to: "/factors/", label: "结论" },
        { to: "/factors/gates", label: "6 关判决" },
        { to: "/factors/buckets", label: "分档明细" },
        { to: "/factors/attrib", label: "缩量归因" },
        { to: "/factors/flow", label: "资金流探路" },
        { to: "/factors/baseline", label: "基线原文" },
      ]}
    />
  );
}

/** 区块外壳。口径说明在标题正下方，不用 Panel（它的 note 在右侧）。 */
export function Section({
  id,
  title,
  hint,
  children,
}: {
  id?: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-3.5 py-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读不到因子判决产物时，给用户看的统一提示（人话，不摆工程细节）。
 *
 * 2026-11-08 全量体检：这里原先直接塞了一整条 `BT_FACTOR=1 node ... scripts/backtest.ts`
 * 命令行，还被 4 个空态/提示渲染出来——和「让用户去开配置文件夹、去拿邮箱授权码」
 * 是同一个毛病：把内部实现当产品。命令挪到 RERUN_COMMAND，主视图只用 RERUN_HINT。
 */
export const RERUN_HINT = "本机还没生成因子判决数据，等下一次收盘自动重跑即可。换机器后需要重新生成一次。";
/** 给开发者的手动重跑命令：只在「给开发者」折叠里用，主视图不许渲染。 */
export const RERUN_COMMAND =
  "BT_FACTOR=1 BT_N=10 node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts";

/**
 * 批次搜索参数校验（实现在 src/lib/search-params.ts，此处转发保持旧导入路径可用）。
 * 地址栏可直达、可刷新保持。0=最旧，不传=最新。
 * 注意：路由器默认把纯数字参数 JSON 解析成 number（?batch=5 → 5），只认 string 会
 * 退回 -1、307 清回 ?batch=-1（2026-10-21 与辩论页 q 吞参同根因）。
 */
export { parseBatch } from "@/lib/search-params";

/**
 * 批次选择器：同一个因子在「持有 3 天」和「持有 20 天」下可能是两个结论，
 * 只看最新一批就把这个差别吞了。这里把每一批的参数（持有天数/换样本/因子数）
 * 标在选择器上，随便切换对比。批次列表来自 factor-runs.jsonl 的聚类，不是手填。
 * to：切批次时落在哪个子页（结论/6 关/分档各有自己的批次视角）。
 */
export function BatchPicker({
  runs,
  current,
  to,
}: {
  runs: FactorRunsPayload;
  current: number;
  to: "/factors/" | "/factors/gates" | "/factors/buckets";
}) {
  const navigate = useNavigate();
  if (runs.batches.length <= 1) return null;
  return (
    <div className="flex items-center gap-2 px-0.5 py-1.5 text-xs text-muted">
      <span>判决批次</span>
      <select
        value={current}
        // 目标子页（含索引页 /factors/）由调用方字面量保证，这里收窄回 string
        // （和 SectionTabs 同一个取舍，见 section-tabs.tsx）。
        onChange={(e) =>
          void navigate({
            to: to as never,
            search: { batch: Number(e.target.value) } as never,
            replace: false,
          })
        }
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none focus:border-brand"
      >
        {runs.batches.map((b, i) => (
          <option key={b.at} value={i}>
            {new Date(b.at).toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
            · 持有{b.n}天{b.offset ? ` · 换样本${b.offset}` : ""} · {b.count}因子
            {i === runs.batches.length - 1 ? "（最新）" : ""}
          </option>
        ))}
      </select>
      <span className="text-[12px]">同一因子换持有期可能是两个结论，来回切着看</span>
    </div>
  );
}
