/**
 * 这个文件是干什么的：
 * 常驻 agent（「小机」）的任务账本 + 预算闸门（data/agent-jobs.json）。
 * 每次派活记一条：谁派的、干了什么、跑没跑成、花了多少。默认永远待命——
 * 没有任务就没有进程、零消耗；自己想干的活只能进建议工单等人批。
 *
 * 你需要知道的：
 * 1. 预算三级闸（agent-budget.json 配置）：单任务 / 单日 / 单月（元）。
 *    超限 = 拒绝派活（单任务）/ 杀进程（运行中超限由 runner 查）。
 *    熔断后推送通知（best-effort，推送挂了不影响闸门本身）。
 * 2. 无人值守的「主动派活」默认焊死：auto 任务只允许来自任务清单配置
 *    （每条可独立关），agent 自己没有派活入口。
 * 3. 纯函数（预算判定、账本统计）不依赖 fs，直接单测。
 * 4. node API 函数内动态 import（浏览器兼容，同 ai-log.ts 的坑）。
 */

const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——同 ai-log.ts 文件头的浏览器兼容坑。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const jobsPath = () => posixJoin(dataDir(), "agent-jobs.json");
const budgetPath = () => posixJoin(dataDir(), "agent-budget.json");
const switchPath = () => posixJoin(dataDir(), "agent-master-switch.json");

// ── 数据结构 ────────────────────────────────────────────────────

/** 一次派活的完整记录。 */
export type AgentJob = {
  /** ISO 时间（派活时刻）。 */
  at: string;
  /** 任务描述（用户原文 / 定时任务名）。 */
  task: string;
  /** manual = 主人派的；scheduled = 定时任务清单里的。 */
  trigger: "manual" | "scheduled";
  /** scheduled 时的任务清单条目 id。 */
  scheduleId?: string;
  /** 预算闸门判定时的本次任务预算（元）。 */
  budgetCny: number;
  /** 跑成没有：running 时还没结果。 */
  status: "running" | "ok" | "error" | "budget-killed";
  /** 结束时刻。 */
  endedAt?: string;
  /** agent 的最终回答（截前 4000 字）。 */
  answer?: string;
  /** 失败原因。 */
  error?: string;
  /** 实际消耗（元，进程结束后从 usage 统计回填；估算口径标注 estimated）。 */
  cost?: { cny: number; estimated: boolean };
  /** session 续接 id（--session-id），带记忆的任务链。 */
  sessionId?: string;
};

/** 预算配置。用户可在 /ai 页改。 */
export type AgentBudget = {
  perTaskCny: number;
  perDayCny: number;
  perMonthCny: number;
};

export const DEFAULT_BUDGET: AgentBudget = { perTaskCny: 2, perDayCny: 5, perMonthCny: 100 };

/** 账本上限：满了丢最旧的。 */
export const AGENT_JOBS_CAP = 200;

// ── 纯函数：预算闸门判定 ────────────────────────────────────────

/** 某天（本地 YYYY-MM-DD）已花的合计。cost 缺失的按 0 计（没回填不瞎算）。 */
export function spentOnDay(jobs: AgentJob[], day: string): number {
  return jobs
    .filter((j) => j.at.slice(0, 10) === day && j.status !== "running")
    .reduce((a, j) => a + (j.cost?.cny ?? 0), 0);
}

/** 某月（本地 YYYY-MM）已花的合计。 */
export function spentInMonth(jobs: AgentJob[], month: string): number {
  return jobs
    .filter((j) => j.at.slice(0, 7) === month && j.status !== "running")
    .reduce((a, j) => a + (j.cost?.cny ?? 0), 0);
}

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * 派活闸门：派之前判。day/month 是本地口径（调用方传，保持纯函数）。
 * 逻辑：当日已花 + 本次预算 > 单日上限 → 拒；当月同理。单任务预算本身就是上限。
 */
export function gateJob(jobs: AgentJob[], budget: AgentBudget, taskBudgetCny: number, day: string, month: string): GateVerdict {
  const daySpent = spentOnDay(jobs, day);
  if (daySpent + taskBudgetCny > budget.perDayCny + 1e-9) {
    return { allowed: false, reason: `单日预算已满：今天已花 ${daySpent.toFixed(2)} 元 + 本次上限 ${taskBudgetCny} 元 > 日上限 ${budget.perDayCny} 元。去 /ai 页调高预算或明天再跑。` };
  }
  const monthSpent = spentInMonth(jobs, month);
  if (monthSpent + taskBudgetCny > budget.perMonthCny + 1e-9) {
    return { allowed: false, reason: `当月预算已满：本月已花 ${monthSpent.toFixed(2)} 元 + 本次上限 ${taskBudgetCny} 元 > 月上限 ${budget.perMonthCny} 元。` };
  }
  return { allowed: true };
}

/** 运行中任务的预算审计：按 usage 回填的实际花费判断是否该杀。 */
export function budgetExceeded(job: AgentJob, budget: AgentBudget): boolean {
  if (job.status !== "running") return false;
  return (job.cost?.cny ?? 0) > budget.perTaskCny + 1e-9;
}

// ── 文件 IO ────────────────────────────────────────────────────

export async function readAgentJobs(): Promise<AgentJob[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(jobsPath(), "utf8")) as { jobs?: unknown };
    if (Array.isArray(parsed.jobs)) return parsed.jobs as AgentJob[];
  } catch {
    // 没有账本 = 还没派过活，正常。
  }
  return [];
}

export async function appendAgentJob(job: AgentJob): Promise<void> {
  try {
    const jobs = [...(await readAgentJobs()), job];
    const trimmed = jobs.length > AGENT_JOBS_CAP ? jobs.slice(jobs.length - AGENT_JOBS_CAP) : jobs;
    const { mkdir, writeFile } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(jobsPath(), JSON.stringify({ jobs: trimmed }, null, 2));
  } catch {
    // 账本写失败不抛错——派活本身不该被记账失败炸掉。
  }
}

/** 更新一条任务（按 at 精确匹配；找不到就静默——运行器崩了不炸账本）。 */
export async function updateAgentJob(at: string, patch: Partial<AgentJob>): Promise<void> {
  try {
    const jobs = await readAgentJobs();
    const next = jobs.map((j) => (j.at === at ? { ...j, ...patch } : j));
    const { mkdir, writeFile } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(jobsPath(), JSON.stringify({ jobs: next }, null, 2));
  } catch {
    // 同上，静默。
  }
}

export async function readAgentBudget(): Promise<AgentBudget> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(budgetPath(), "utf8")) as Partial<AgentBudget>;
    return {
      perTaskCny: typeof parsed.perTaskCny === "number" && parsed.perTaskCny > 0 ? parsed.perTaskCny : DEFAULT_BUDGET.perTaskCny,
      perDayCny: typeof parsed.perDayCny === "number" && parsed.perDayCny > 0 ? parsed.perDayCny : DEFAULT_BUDGET.perDayCny,
      perMonthCny: typeof parsed.perMonthCny === "number" && parsed.perMonthCny > 0 ? parsed.perMonthCny : DEFAULT_BUDGET.perMonthCny,
    };
  } catch {
    return DEFAULT_BUDGET;
  }
}

export async function writeAgentBudget(budget: AgentBudget): Promise<void> {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(budgetPath(), JSON.stringify(budget, null, 2));
}

// ── 总开关（2026-11-14 用户要求）：一个数字管全部三个口子 ──────────────
// off = 手动派活/定时调度/工单执行全拒（桌宠降级为灰色「已停用」）；
// on  = 恢复各口子自己的开关状态。文件不存在 = on（默认开放，各口子自己管自己）。

export type MasterSwitch = { enabled: boolean; at: string; by?: string };

export async function readMasterSwitch(): Promise<MasterSwitch> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(switchPath(), "utf8")) as { enabled?: unknown; at?: unknown; by?: unknown };
    if (typeof parsed.enabled === "boolean") {
      return { enabled: parsed.enabled, at: typeof parsed.at === "string" ? parsed.at : "", by: typeof parsed.by === "string" ? parsed.by : undefined };
    }
  } catch {
    // 没有文件 = 默认开。
  }
  return { enabled: true, at: "" };
}

export async function writeMasterSwitch(enabled: boolean): Promise<void> {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  const doc: MasterSwitch = { enabled, at: new Date().toISOString(), by: "owner" };
  await writeFile(switchPath(), JSON.stringify(doc, null, 2));
}
