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

/** 是否正在冷却（保留给调用方查询；2026-11-15 复检：跨 tick 冷却由 home-server
 *  的 agentTickRunning 单进程防重入负责——模块级内存每 60s 新 spawn 会归零，
 *  不可靠。同 tick 内的串行由 tickAgentSchedules 的 dispatched 变量保证）。 */
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
  const { updateAgentJob } = await import("./agent-jobs.ts");
  const schedules = await readAgentSchedules();
  // 上海日/时（2026-11-16 修）：原先按运行机本地时区，跨时区部署会错日/错点。
  const { shanghaiDate, shanghaiHour } = await import("./session.ts");
  const day = shanghaiDate(now.getTime());
  const hour = shanghaiHour(now.getTime());

  let dispatched: string | null = null;
  let skipped = 0;
  for (const s of schedules as AgentSchedule[]) {
    if (!scheduleDue(s, { day, hour })) {
      skipped += 1;
      continue;
    }
    // 一次 tick 只派一条（agent 串行）；其余的留给下个 tick。
    // 不再查 inCooldown 模块内存——home-server 每 60s 新 spawn 会让它归零，
    // 且 lastDispatchAt 会污染同进程内的后续调用（测试里暴露过）。
    if (dispatched) {
      skipped += 1;
      continue;
    }
    lastDispatchAt = now.getTime();
    dispatched = s.id;
    const r = await runTask({ task: s.task, scheduleId: s.id, budgetCny: s.budgetCny });
    await updateAgentJob(r.jobAt, { status: r.status, endedAt: new Date().toISOString(), ...(r.cost != null ? { cost: { cny: r.cost, estimated: true } } : {}), ...(r.error ? { error: r.error } : {}), ...(r.answer ? { answer: r.answer.slice(0, 4000) } : {}) });
    // 只有真正跑成（ok + status=ok）才消耗当天名额；失败留给下个 tick 补跑。
    if (!r.ok || r.status !== "ok") continue;
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
  const { readAgentJobs, readAgentBudget, appendAgentJob, gateJob } = await import("./agent-jobs.ts");
  const budget = await readAgentBudget();
  const jobsForGate = await readAgentJobs();
  // 预算闸在写 running 账之前判（2026-11-15 复检补）：被拒就不该留一条 error 账、
  // 也不该占用当天名额。runAgentTask 内还有同一道闸（防御式重复，无害）。
  const nowIso = new Date().toISOString();
  const gate = gateJob(jobsForGate, budget, budget.perTaskCny, nowIso.slice(0, 10), nowIso.slice(0, 7));
  if (!gate.allowed) {
    // 被预算闸拦下也记一条账（可审计），但状态就是 budget-killed，不写 running 再改。
    await appendAgentJob({
      at: nowIso,
      task: opts.task,
      trigger: "scheduled",
      scheduleId: opts.scheduleId,
      budgetCny: budget.perTaskCny,
      status: "budget-killed",
      endedAt: nowIso,
      error: gate.reason,
    });
    return { ok: false, status: "budget-killed", error: gate.reason, jobAt: nowIso };
  }
  const at = nowIso;
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
