/**
 * 这个文件是干什么的：
 * 定时任务执行器：home-server 每 60 秒调一次 tickAgentSchedules()，到点的任务
 * 派给 agent-runner（trigger=scheduled，账本照记）。冷却 30 秒防重叠——上一条
 * 还在跑时不派下一条（agent 一次只干一件事）。
 *
 * 你需要知道的：
 * 1. 这是口子②的唯一执行点：任务来自 agent-schedules.json（主人逐条审过的），
 *    agent 自己没有派活入口。
 * 2. 到点判定用本地时区（和 launchd 的 StartCalendarInterval 同一口径）。
 * 3. 全部 best-effort：挂了 console.error，不影响记账主进程。
 * 4. node API 函数内动态 import。
 */

import type { AgentSchedule } from "./agent-schedules.ts";
import { scheduleDue } from "./agent-schedules.ts";

/** 模块级冷却：60 秒 tick 之间防重叠。 */
let lastDispatchAt = 0;
const COOLDOWN_MS = 30_000;

/** 是否正在冷却（导出给测试/页面提示用）。 */
export function inCooldown(now = Date.now()): boolean {
  return now - lastDispatchAt < COOLDOWN_MS;
}

export type TickResult = { dispatched: string | null; skipped: number; checked: number };

/**
 * 扫一遍任务清单，到点的派活。返回派了哪个（id）。
 * @param runTask 派活的实现（agent-runner.runAgentTask 的注入点，测试可换桩）。
 */
export async function tickAgentSchedules(
  now: Date = new Date(),
  runTask: (opts: { task: string; scheduleId: string; budgetCny: number }) => Promise<{ ok: boolean; status: "ok" | "error" | "budget-killed"; cost?: number; error?: string; answer?: string; jobAt: string }> = runViaRunner,
): Promise<TickResult> {
  // 总开关（口子②）：off = 整个 tick 直接空转，连清单都不读。
  const { readMasterSwitch } = await import("./agent-jobs.ts");
  if (!(await readMasterSwitch()).enabled) return { dispatched: null, skipped: 0, checked: 0 };
  const { readAgentSchedules, writeAgentSchedules } = await import("./agent-schedules.ts");
  const { readAgentJobs, readAgentBudget, appendAgentJob, updateAgentJob } = await import("./agent-jobs.ts");
  const schedules = await readAgentSchedules();
  const day = now.toLocaleDateString("sv-SE"); // 本地 YYYY-MM-DD
  const hour = now.getHours();

  let dispatched: string | null = null;
  let skipped = 0;
  for (const s of schedules as AgentSchedule[]) {
    if (!scheduleDue(s, { day, hour })) {
      skipped += 1;
      continue;
    }
    if (dispatched || inCooldown(now.getTime())) {
      // 一次 tick 只派一条（agent 串行）；其余的留给下个 tick。
      skipped += 1;
      continue;
    }
    lastDispatchAt = now.getTime();
    dispatched = s.id;
    const r = await runTask({ task: s.task, scheduleId: s.id, budgetCny: s.budgetCny });
    await updateAgentJob(r.jobAt, { status: r.status, endedAt: new Date().toISOString(), ...(r.cost != null ? { cost: { cny: r.cost, estimated: true } } : {}), ...(r.error ? { error: r.error } : {}), ...(r.answer ? { answer: r.answer.slice(0, 4000) } : {}) });
    const next = (await readAgentSchedules()).map((x) =>
      x.id === s.id ? { ...x, lastRunDay: day, lastStatus: r.status, lastCost: r.cost } : x,
    );
    await writeAgentSchedules(next);
  }
  return { dispatched, skipped, checked: schedules.length };
}

/** 默认执行实现：走 agent-runner（真正 spawn headless）。 */
async function runViaRunner(opts: { task: string; scheduleId: string; budgetCny: number }): Promise<{ ok: boolean; status: "ok" | "error" | "budget-killed"; cost?: number; error?: string; answer?: string; jobAt: string }> {
  const { runAgentTask } = await import("./agent-runner.ts");
  const { readAgentJobs, readAgentBudget, appendAgentJob } = await import("./agent-jobs.ts");
  void readAgentJobs;
  const budget = await readAgentBudget();
  const jobsForGate = await readAgentJobs();
  const at = new Date().toISOString();
  const job = {
    at,
    task: opts.task,
    trigger: "scheduled" as const,
    scheduleId: opts.scheduleId,
    budgetCny: Math.min(opts.budgetCny, budget.perTaskCny),
    status: "running" as const,
  };
  await appendAgentJob(job);
  try {
    const r = await runAgentTask({
      task: opts.task,
      trigger: "scheduled",
      scheduleId: opts.scheduleId,
      budget,
      jobsForGate,
    });
    // flash 价估算（同 agent-runner.costOfTokens 的口径：input 1.1 / output 4.3 元每百万）
    const cost = r.tokens ? (r.tokens.input / 1e6) * 1.1 + (r.tokens.output / 1e6) * 4.3 : undefined;
    return {
      ok: r.ok,
      status: r.ok ? "ok" : "error",
      cost,
      error: r.error,
      answer: r.answer,
      jobAt: at,
    };
  } catch (err) {
    return { ok: false, status: "error", error: err instanceof Error ? err.message.slice(0, 300) : String(err), jobAt: at };
  }
}
