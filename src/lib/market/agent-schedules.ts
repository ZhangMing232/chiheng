/**
 * 这个文件是干什么的：
 * 小机的定时任务清单（data/agent-schedules.json）+ 建议工单收件箱
 * （data/agent-proposals.json）。这是「派活」的另外两个口子：
 *
 * 口子② 定时任务：主人预先登记的任务，home-server 到点自动派——每条独立开关、
 *   每条有预算上限、每天最多跑一次（stamp 去重），账本照记（trigger=scheduled）。
 * 口子③ 建议工单：agent 干活时「顺手发现」的问题，写成工单等人批——
 *   **agent 自己没有任何派活入口**（用户 2026-11-14 定的纪律），批准后由主人
 *   点一下才转成 manual 派活。
 *
 * 你需要知道的：
 * 1. 任务清单/工单都是纯数据文件；派活的执行在 agent-runner.ts，闸门共用。
 * 2. 纯函数（到点判定、工单状态机）不依赖 fs，直接单测。
 * 3. node API 函数内动态 import（浏览器兼容铁律，同 ai-log.ts）。
 */

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const schedulesPath = () => posixJoin(dataDir(), "agent-schedules.json");
const proposalsPath = () => posixJoin(dataDir(), "agent-proposals.json");

// ── 定时任务 ────────────────────────────────────────────────────

/** 一条定时任务。 */
export type AgentSchedule = {
  id: string;
  /** 任务描述（原样派给 agent）。 */
  task: string;
  /** 每天几点（本地时区的 0-23 小时）。 */
  hourLocal: number;
  /** 独立开关——关了就是彻底不跑，不是静默跳过。 */
  enabled: boolean;
  /** 本条任务的预算上限（元），派活时覆盖全局单任务预算。 */
  budgetCny: number;
  /** 上次跑的本地日期（YYYY-MM-DD），一天最多一次。 */
  lastRunDay?: string;
  /** 上次结果摘要（给清单页看）。 */
  lastStatus?: "ok" | "error" | "budget-killed";
  lastCost?: number;
};

/** 到点判定（纯函数）：enabled + 当天没跑过 + 小时到了。 */
export function scheduleDue(
  s: AgentSchedule,
  nowLocal: { day: string; hour: number },
): boolean {
  if (!s.enabled) return false;
  if (s.lastRunDay === nowLocal.day) return false;
  return s.hourLocal <= nowLocal.hour;
}

/** 默认任务清单：三条高频运维，全部默认**关着**——主人逐条审过再开。 */
export const DEFAULT_SCHEDULES: AgentSchedule[] = [
  {
    id: "daily-health",
    task: "快速体检：git status 是否有未提交改动、evolve-breaker 状态、ai-log 最后 3 条有没有异常。发现问题的话写进「顺手发现」，不要动手修。",
    hourLocal: 9,
    enabled: false,
    budgetCny: 1,
  },
  {
    id: "post-close-check",
    task: "收盘后核对：读 data/ai-log.json 里今天 trigger=auto 的记录，对照账号本检查四层闭环（agent/factor/strategy/genome）是否都有 ok=true 的产出；缺哪层报哪层，只报告不动手。",
    hourLocal: 16,
    enabled: false,
    budgetCny: 1,
  },
  {
    id: "weekly-ledger-audit",
    task: "周账审计：读 data/ai-usage.json，统计近 7 天调用次数/费用（两口径分列），和 agent-jobs.json 的成本对账，发现口径不一致的地方写清楚。只报告。",
    hourLocal: 8,
    enabled: false,
    budgetCny: 1,
  },
];

export async function readAgentSchedules(): Promise<AgentSchedule[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(schedulesPath(), "utf8")) as { schedules?: unknown };
    if (Array.isArray(parsed.schedules)) return parsed.schedules as AgentSchedule[];
  } catch {
    // 没有配置 = 还没初始化，用默认清单。
  }
  return DEFAULT_SCHEDULES;
}

export async function writeAgentSchedules(schedules: AgentSchedule[]): Promise<void> {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(schedulesPath(), JSON.stringify({ schedules }, null, 2));
}

// ── 建议工单 ────────────────────────────────────────────────────

/** 一条工单：agent 干活时顺手发现的问题，等人拍板。 */
export type AgentProposal = {
  id: string;
  at: string;
  /** 哪次任务里发现的（关联 agent-jobs 的 at）。 */
  jobAt: string;
  /** 问题描述。 */
  finding: string;
  /** agent 建议的修法。 */
  suggestion: string;
  status: "pending" | "approved" | "dismissed";
  decidedAt?: string;
};

export const AGENT_PROPOSALS_CAP = 100;

export async function readAgentProposals(): Promise<AgentProposal[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(proposalsPath(), "utf8")) as { proposals?: unknown };
    if (Array.isArray(parsed.proposals)) return parsed.proposals as AgentProposal[];
  } catch {
    return [];
  }
  return [];
}

export async function appendAgentProposal(p: AgentProposal): Promise<void> {
  try {
    const list = [...(await readAgentProposals()), p];
    await writeAgentProposalsFile(list);
  } catch {
    // 工单写失败不炸主流程。
  }
}

/** 全量覆写工单文件（审批走这里）。 */
export async function writeAgentProposalsFile(list: AgentProposal[]): Promise<void> {
  const trimmed = list.length > AGENT_PROPOSALS_CAP ? list.slice(list.length - AGENT_PROPOSALS_CAP) : list;
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(proposalsPath(), JSON.stringify({ proposals: trimmed }, null, 2));
}

/** 工单状态机（纯函数）：pending 才能被批/驳，批过驳过的不能再动。 */
export function decideProposal(
  list: AgentProposal[],
  id: string,
  decision: "approved" | "dismissed",
): { list: AgentProposal[]; changed: boolean } {
  let changed = false;
  const next = list.map((p) => {
    if (p.id !== id || p.status !== "pending") return p;
    changed = true;
    return { ...p, status: decision, decidedAt: new Date().toISOString() };
  });
  return { list: next, changed };
}

/** 从 agent 回答里抽取「顺手发现」段落（纯函数）：找不到就空串。
 *  约定格式：回答末尾有一行以「顺手发现」开头的段落。 */
export function extractFindings(answer: string): string {
  const idx = answer.indexOf("顺手发现");
  if (idx < 0) return "";
  const seg = answer.slice(idx);
  // 截到下一个 markdown 标题或 1200 字
  const cut = seg.search(/\n#{1,3} |\n---/);
  return (cut > 0 ? seg.slice(0, cut) : seg).trim().slice(0, 1200);
}
