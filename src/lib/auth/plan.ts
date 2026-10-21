/**
 * 这个文件是干什么的：
 * 会员档位词表的唯一真源（design/MEMBERSHIP.md §二）和中文标签。
 *
 * 你需要知道的：
 * 改档位名/加档位只改这里 + MEMBERSHIP.md + migrations（如果有新字段需求）。
 * 闸判定用 isPaidPlan / isAdmin，别在调用处散字符串比较。
 */

/** 全部合法档位。free 是注册默认；admin 只能人工授予。 */
export const PLANS = ["free", "pro-monthly", "pro-yearly", "lifetime", "admin"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LABELS: Record<Plan, string> = {
  free: "免费版",
  "pro-monthly": "Pro · 月付",
  "pro-yearly": "Pro · 年付",
  lifetime: "终身会员",
  admin: "站长",
};

export function isPlan(v: unknown): v is Plan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}

/** 付费档位（含终身和站长）——未来 requirePlan 硬闸用它。 */
export function isPaidPlan(plan: string | null | undefined): boolean {
  return plan !== null && plan !== undefined && plan !== "free";
}

export function isAdmin(plan: string | null | undefined): boolean {
  return plan === "admin";
}

/** 展示用：未知档位原样返回，不编标签。 */
export function planLabel(plan: string | null | undefined): string {
  return isPlan(plan) ? PLAN_LABELS[plan] : (plan ?? "免费版");
}
