/**
 * 这个文件是干什么的：
 * 小机统一时间线（概览页「今日账目」的数据源）：把两本账（例行 ai-log 四层 +
 * 派活 agent-jobs）映射成一条按时间混排的流水，每条标来源徽章。纯函数，直接单测。
 *
 * 你需要知道的：
 * 1. 只做显示层映射：原始文件一字不动——例行账仍是例行 prompt 的自我历史输入
 *    （ai-log 的下游语义不碰），派活账仍是审计账。
 * 2. 例行条目的花费从 ai-usage 按 at 时间窗回填（usage 条目有 cost 字段；
 *    没回填到的如实标 null，不瞎算）。
 * 3. 排序键统一用 at ISO 字符串比较（同源同格式，无需 Date 解析）。
 */

import type { AILogEntry } from "./ai-log.ts";
import type { AIUsageEntry } from "./ai-usage.ts";
import type { AgentJob } from "./agent-jobs.ts";

/** 时间线上一条。 */
export type TimelineItem = {
  at: string;
  /** routine = 例行四层；manual = 主人派活；scheduled = 定时任务。 */
  source: "routine" | "manual" | "scheduled";
  /** 例行时是层名（agent/factor/strategy/genome），派活时是 "task"。 */
  kind: string;
  /** 一句话摘要。 */
  title: string;
  /** 明细（例行=提议/被拒；派活=回答前 200 字）。 */
  detail: string | null;
  /** 花费（元）。例行从 usage 窗口回填；派活自带的照用；都没有 = null。 */
  costCny: number | null;
  /** 状态：例行 ok 就是 ok；派活原样。 */
  status: "ok" | "error" | "running" | "budget-killed";
};

/** 层名 → 中文。 */
const LAYER_CN: Record<string, string> = {
  agent: "诊断（观察）",
  factor: "因子层",
  strategy: "策略层",
  genome: "基因组层",
};

/** 例行一条的摘要。 */
function routineTitle(e: AILogEntry): string {
  const layer = LAYER_CN[e.layer] ?? e.layer;
  if (!e.ok) return `${layer} · 跑失败`;
  if (e.layer === "agent") return `${layer} · 报告已出`;
  const parts: string[] = [`${layer}`];
  if (e.proposed.length > 0) parts.push(`进 ${e.proposed.length} 条`);
  if (e.rejected.length > 0) parts.push(`拒 ${e.rejected.length} 条`);
  if (e.proposed.length === 0 && e.rejected.length === 0) parts.push("空转（合理）");
  return parts.join(" · ");
}

/**
 * 合成统一时间线。
 * @param usage ai-usage 全量（例行花费按 [logAt, 下一条 logAt) 时间窗归属）。
 */
export function buildTimeline(
  routineLog: AILogEntry[],
  jobs: AgentJob[],
  usage: AIUsageEntry[],
  limit = 50,
): TimelineItem[] {
  // 例行花费归属：一次模型调用落在哪个例行条目的时间窗内（本条 at 起、下一条同层前）。
  // 简化口径：每次调用归属到「at 之前最近的例行条目」——和记账顺序（调用完才 append）一致。
  const routineSorted = [...routineLog].sort((a, b) => (a.at < b.at ? -1 : 1));
  const usageSorted = [...usage].sort((a, b) => (a.at < b.at ? -1 : 1));
  const costForRoutine = new Map<string, number>();
  let ui = 0;
  for (const r of routineSorted) {
    let sum = 0;
    // 该例行条目之后、下一条例行条目之前的所有调用都算它启动的这一轮。
    const idx = routineSorted.indexOf(r);
    const nextAt = idx + 1 < routineSorted.length ? routineSorted[idx + 1].at : "9999";
    while (ui < usageSorted.length && usageSorted[ui].at < nextAt) {
      if (usageSorted[ui].at >= r.at) sum += usageSorted[ui].cost ?? 0;
      ui += 1;
    }
    costForRoutine.set(r.at, sum);
  }

  const routineItems: TimelineItem[] = routineSorted.map((e) => ({
    at: e.at,
    source: "routine" as const,
    kind: LAYER_CN[e.layer] ?? e.layer,
    title: routineTitle(e),
    detail:
      e.error ??
      (e.rejected.length > 0
        ? e.rejected.slice(0, 2).join("；")
        : e.note ?? (e.proposed.length > 0 ? `提议：${e.proposed.map((p) => p.name).join("、")}` : null)),
    costCny: costForRoutine.get(e.at) ?? null,
    status: e.ok ? "ok" : "error",
  }));

  const jobItems: TimelineItem[] = jobs.map((j) => ({
    at: j.at,
    source: j.trigger,
    kind: "task" as const,
    title: j.task.slice(0, 60) + (j.task.length > 60 ? "…" : ""),
    detail:
      j.status === "running"
        ? "进行中…"
        : (j.answer?.slice(0, 200) ?? j.error ?? null),
    costCny: j.cost?.cny ?? null,
    status: j.status,
  }));

  return [...routineItems, ...jobItems]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

/** 今日已花合计（例行走 usage 窗口回填的结果，派活用自己的 cost）。 */
export function spentOn(timeline: TimelineItem[], day: string): number {
  return timeline
    .filter((t) => t.at.slice(0, 10) === day && t.status !== "running")
    .reduce((a, t) => a + (t.costCny ?? 0), 0);
}
