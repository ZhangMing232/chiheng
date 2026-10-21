/**
 * 这个文件是干什么的：
 * AI 额度闸——会员体系的第一道硬闸（design/MEMBERSHIP.md §四 #1：AI token
 * 成本真实，最该收费）。AI 闭环（进化/诊断）走内置接口，调用费记在老板账上；
 * 免费用户放开 = 老板倒贴。所以按 plan 限每日次数：
 *
 *   free        0  次 —— 不能跑，提示升级
 *   pro-monthly 进化 2 轮 / 诊断 5 次每天
 *   pro-yearly  进化 3 轮 / 诊断 10 次每天
 *   lifetime    进化 5 轮 / 诊断 20 次每天
 *   admin（主人）无限 —— 自己用自己的，不计
 *
 * 你需要知道的：
 * 1. **只闸「主动触发」**：/ai 页的按钮和（未来）非主人会话。收盘后的 autoEvolve
 *    是系统行为、主人自己的开关，走记账进程，不过这道闸。
 * 2. 计数按自然日（上海时）清零：data/ai-quota.json 记 {userId: {date, evolve,
 *    diagnose}}，日期对不上就重置。计数在调用**前**累加——失败的调用也烧钱，
 *    不许退（刷重试无成本 = 漏洞）。
 * 3. 纯函数（quotaOf / checkQuota / nextQuotaState）零 I/O 直接单测；
 *    文件读写（readAIQuota / bumpAIQuota / assertAIQuota）server-only。
 * 4. 词表外的 plan（数据异常）按 free 对待——宁可误拦不可误放。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan } from "@/lib/auth/plan";

export type AIQuotaKind = "evolve" | "diagnose";

/** 每档每天的额度。Infinity = 不限（admin 自己用自己接口）。 */
export const AI_QUOTA: Record<Plan, Record<AIQuotaKind, number>> = {
  free: { evolve: 0, diagnose: 0 },
  "pro-monthly": { evolve: 2, diagnose: 5 },
  "pro-yearly": { evolve: 3, diagnose: 10 },
  lifetime: { evolve: 5, diagnose: 20 },
  admin: { evolve: Infinity, diagnose: Infinity },
};

/** 取档位的额度。词表外的 plan 按 free（宁可误拦不可误放）。 */
export function quotaOf(plan: string | null | undefined): Record<AIQuotaKind, number> {
  return AI_QUOTA[(plan ?? "free") as Plan] ?? AI_QUOTA.free;
}

/** 额度判定：allowed / limit / 已用。limit=Infinity 永远 allowed。 */
export function checkQuota(
  plan: string | null | undefined,
  kind: AIQuotaKind,
  used: number,
): { allowed: boolean; limit: number; used: number } {
  const limit = quotaOf(plan)[kind];
  return { allowed: used < limit, limit, used };
}

/** 一条计数：哪天用了几次。 */
export type QuotaState = { date: string; evolve: number; diagnose: number };

/**
 * 推进计数（纯函数）：日期变了先清零（新的一天），再 kind +1。
 * bump 永远允许超 1——超档的调用在 assertAIQuota 就被拦了，走到这的都在额度内；
 * 记账比判定松一格，防止并发下两个都过闸都记账时丢数。
 */
export function nextQuotaState(prev: QuotaState | null, today: string, kind: AIQuotaKind): QuotaState {
  const base: QuotaState = prev && prev.date === today ? prev : { date: today, evolve: 0, diagnose: 0 };
  return { ...base, [kind]: base[kind] + 1 };
}

// ── 文件 IO（server-only）────────────────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const quotaPath = () => join(dataDir(), "ai-quota.json");

/** 全量计数表。文件不在/坏了 → 空表，绝不抛错（闸不能因为账本挂了把人锁死）。 */
export async function readQuotaTable(): Promise<Record<string, QuotaState>> {
  try {
    const parsed = JSON.parse(await readFile(quotaPath(), "utf8")) as { byUser?: unknown };
    if (!parsed.byUser || typeof parsed.byUser !== "object") return {};
    return parsed.byUser as Record<string, QuotaState>;
  } catch {
    return {};
  }
}

/** 调用前累加一次（失败调用也计，见文件头 2）。写失败不抛——记账失败不炸调用。 */
export async function bumpAIQuota(userId: string, kind: AIQuotaKind, today: string): Promise<void> {
  try {
    const table = await readQuotaTable();
    table[userId] = nextQuotaState(table[userId] ?? null, today, kind);
    await mkdir(dataDir(), { recursive: true });
    await writeFile(quotaPath(), JSON.stringify({ byUser: table }, null, 2));
  } catch (error) {
    console.error("ai-quota 写入失败（不影响调用结果）:", (error as Error).message);
  }
}

/** 闸：过则安静返回，不过则抛带指引的错（前端直接展示 message）。 */
export async function assertAIQuota(
  user: { userId: string; isOwner: boolean; plan: string | null },
  kind: AIQuotaKind,
  today: string,
): Promise<void> {
  if (user.isOwner) return; // 主人自己用自己接口，不限
  const table = await readQuotaTable();
  const used = table[user.userId]?.date === today ? table[user.userId][kind] : 0;
  const { allowed, limit } = checkQuota(user.plan, kind, used);
  if (allowed) return;
  const label = kind === "evolve" ? "AI 进化" : "全局诊断";
  if (limit <= 0) {
    throw new Error(`免费版不能跑${label}——升级后解锁每日额度：/membership`);
  }
  throw new Error(`今日${label}额度已用完（${used}/${limit === Infinity ? "∞" : limit}）——明天再来，或升级提额：/membership`);
}

/** 今天已用（给页面展示「今日额度 x/y」用）。 */
export async function quotaUsage(userId: string, today: string): Promise<QuotaState> {
  const row = (await readQuotaTable())[userId];
  return row && row.date === today ? row : { date: today, evolve: 0, diagnose: 0 };
}
