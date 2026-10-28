/**
 * 这个文件是干什么的：
 * 优化闭环的「应用层」。AI 诊断产出结构化 `ruleDeltas`（改哪个判决规则键、
 * 改成多少、为什么），这里按混合审批把它落地：
 *
 *  - **tunable 键**（earlyRejectDays / earlyRejectGap，纸面时间盒类）→ 直接写
 *    data/challenger-rule.json 自动生效，并记审计（前后值 + 原因 + 时间 + 谁）。
 *  - **core 键**（minTrades / promoteT / rejectT / maxTrades，真正决定判不判、
 *    判什么）→ 只写进 data/pending-rule-changes.json 待人工拍板，绝不自动生效。
 *
 * 为什么这样分：用户要「规则不写死 → 不断优化」，但核心判决阈值改错会让
 * 真实冠军/挑战者判错，属于不可逆决策。所以自动只碰模拟内的参数，核心阈值
 * 留人工闸——这就是「混合」。
 *
 * 你需要知道的：
 * - 审计 append-only：data/rule-change-log.jsonl，一行一次（auto/approved/rejected）。
 *   回滚靠它知道上一任是什么（配合 challenger-rule.json 当前值）。
 * - 浏览器兼容：node API 必须函数内动态 import、posixJoin 拼路径（同 challenger 头注）。
 * - applyRuleDeltas 是纯 IO 编排，不碰 AI；由 runAgentDiagnosis 在 trigger=auto 时调用。
 *   手动诊断只看不落规则（人跑一次诊断不该悄悄改系统）。
 */

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");
import {
  CHALLENGER_RULE,
  isCoreRuleKey,
  loadChallengerRule,
  saveChallengerRule,
  type ChallengerRule,
} from "./challenger.ts";
import type { RuleDelta } from "./agent-loop.ts";

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}
const pendingPath = () => posixJoin(dataDir(), "pending-rule-changes.json");
const auditPath = () => posixJoin(dataDir(), "rule-change-log.jsonl");

export type RuleChangeStatus = "pending" | "applied" | "rejected";

export type PendingRuleChange = {
  id: string;
  at: string;
  /** 规则键（ChallengerRule 的某个字段名）。 */
  key: string;
  /** 提出时的生效值。 */
  from: number;
  /** 建议改成。 */
  to: number;
  why: string;
  status: RuleChangeStatus;
  decidedAt?: string;
};

export type RuleChangeAudit = {
  at: string;
  key: string;
  from: number;
  to: number;
  why: string;
  mode: "auto" | "approved" | "rejected";
  /** 谁做的：optimizer（自动）/ owner（人工审批）。 */
  by: string;
};

/** 生成稳定可读的 id（时间 + 随机尾巴），不依赖 uuid 包。 */
function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 读待确认规则变更。文件不存在/坏了 → 空数组。 */
export async function readPendingRuleChanges(): Promise<PendingRuleChange[]> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(pendingPath(), "utf8"));
    return Array.isArray(parsed) ? (parsed as PendingRuleChange[]) : [];
  } catch {
    return [];
  }
}

async function writePendingRuleChanges(list: PendingRuleChange[]): Promise<void> {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(pendingPath(), JSON.stringify(list, null, 2));
}

/** 追加一条审计。失败不抛（审计是增强项，不能拖垮优化主流程）。 */
export async function appendRuleChangeAudit(entry: RuleChangeAudit): Promise<void> {
  try {
    const { appendFile, mkdir } = await fsApi();
    await mkdir(dataDir(), { recursive: true });
    await appendFile(auditPath(), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // 审计写不进去只丢一条记录，不影响规则本身已生效。
  }
}

/** 读全部审计（新的在前）。页面/回滚用。 */
export async function readRuleChangeLog(): Promise<RuleChangeAudit[]> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(auditPath(), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RuleChangeAudit)
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

export type ApplyDeltasResult = {
  /** 自动生效的 tunable 键。 */
  applied: string[];
  /** 转入待确认的核心键。 */
  queued: string[];
  /** 不认识 / 非法的键（忽略，记下来给人看）。 */
  ignored: string[];
};

/**
 * 应用一批规则增量（来自 AI 诊断的 ruleDeltas）。
 * tunable 直接落盘 + 审计；core 进待确认队列（同键 pending 去重更新）。
 * 未知键忽略（AI 报了个不存在的规则名，不猜）。
 */
export async function applyRuleDeltas(deltas: RuleDelta[], by = "optimizer"): Promise<ApplyDeltasResult> {
  const rule = await loadChallengerRule();
  const pending = await readPendingRuleChanges();
  const applied: string[] = [];
  const queued: string[] = [];
  const ignored: string[] = [];
  const patch: Partial<ChallengerRule> = {};
  const now = new Date().toISOString();
  const ruleKeys = Object.keys(CHALLENGER_RULE) as (keyof ChallengerRule)[];

  for (const delta of deltas) {
    const key = delta.key as keyof ChallengerRule;
    if (!ruleKeys.includes(key) || !Number.isFinite(delta.to)) {
      ignored.push(delta.key);
      continue;
    }
    const from = rule[key];
    if (from === delta.to) continue;
    if (isCoreRuleKey(key)) {
      const existing = pending.find((p) => p.key === key && p.status === "pending");
      if (existing) {
        existing.to = delta.to;
        existing.why = delta.why;
        existing.at = now;
      } else {
        pending.push({ id: newId(), at: now, key, from, to: delta.to, why: delta.why, status: "pending" });
      }
      queued.push(key);
    } else {
      patch[key] = delta.to;
      applied.push(key);
    }
  }

  if (Object.keys(patch).length > 0) {
    await saveChallengerRule(patch);
    for (const key of applied) {
      const k = key as keyof ChallengerRule;
      await appendRuleChangeAudit({ at: now, key, from: rule[k], to: patch[k]!, why: deltas.find((d) => d.key === key)?.why ?? "", mode: "auto", by });
    }
  }
  if (queued.length > 0) await writePendingRuleChanges(pending);
  return { applied, queued, ignored };
}

/** 人工批准一条待确认（核心键）变更：写规则 + 标 applied + 审计。找不到/非 pending 返回 null。 */
export async function applyPendingRuleChange(id: string): Promise<PendingRuleChange | null> {
  const list = await readPendingRuleChanges();
  const item = list.find((p) => p.id === id && p.status === "pending");
  if (!item) return null;
  const rule = await loadChallengerRule();
  const key = item.key as keyof ChallengerRule;
  if (!(key in CHALLENGER_RULE)) return null;
  const from = rule[key];
  await saveChallengerRule({ [key]: item.to } as Partial<ChallengerRule>);
  item.status = "applied";
  item.decidedAt = new Date().toISOString();
  await writePendingRuleChanges(list);
  await appendRuleChangeAudit({ at: item.decidedAt, key: item.key, from, to: item.to, why: item.why, mode: "approved", by: "owner" });
  return item;
}

/** 人工驳回一条待确认变更。找不到/非 pending 返回 null。 */
export async function rejectPendingRuleChange(id: string): Promise<PendingRuleChange | null> {
  const list = await readPendingRuleChanges();
  const item = list.find((p) => p.id === id && p.status === "pending");
  if (!item) return null;
  item.status = "rejected";
  item.decidedAt = new Date().toISOString();
  await writePendingRuleChanges(list);
  await appendRuleChangeAudit({ at: item.decidedAt, key: item.key, from: item.from, to: item.to, why: item.why, mode: "rejected", by: "owner" });
  return item;
}
