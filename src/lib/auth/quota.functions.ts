/**
 * 这个文件是干什么的：
 * AI 额度的查询入口（额度闸见 quota.ts，design/MEMBERSHIP.md §四）——会员页
 * 「当前档位」面板用它展示「今日额度：进化 x/y · 诊断 x/y」。
 *
 * 你需要知道的：
 * 1. 只读不记账：这是状态查询，过闸和 bump 都在调用侧（quotes.functions.ts 的 aiGate）。
 * 2. limit 在服务端算好再回（quota.ts 有 node:fs 顶层 import，客户端一个字节都
 *    不能碰它——所以前端不传 plan 也不算额度，全部服务端口径）。
 * 3. 未登录 / 会话拿不到：返回 null，页面静默不显示额度行。
 */

import { createServerFn } from "@tanstack/react-start";
import { quotaOf, quotaUsage } from "@/lib/auth/quota";
import { shanghaiDate } from "@/lib/market/session";

/** 今日额度状态：已用 + 档位上限。Infinity 序列化成 null（「∞」前端自己渲染）。 */
export const getAIQuotaStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requirePrincipal, UnauthorizedError } = await import("@/lib/auth/verify.server");
  let principal: Awaited<ReturnType<typeof requirePrincipal>>;
  try {
    principal = await requirePrincipal();
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
  const today = shanghaiDate();
  const used = await quotaUsage(principal.userId, today);
  const limit = quotaOf(principal.plan);
  return {
    plan: principal.plan,
    used: { evolve: used.evolve, diagnose: used.diagnose },
    limit: {
      evolve: limit.evolve === Infinity ? null : limit.evolve,
      diagnose: limit.diagnose === Infinity ? null : limit.diagnose,
    },
  };
});
