/**
 * 这个文件是干什么的：
 * 简易管理系统的服务端函数——列用户、改档位。只有站长（plan === "admin"）能调用。
 *
 * 你需要知道的：
 * - 依赖 better-auth 的 user 表（含 membership 迁移加的 plan 字段）。
 * - 本机内存 PGLite 下用户重启即清空，管理页要真用必须挂 Neon（DATABASE_URL）。
 * - 改档位的口径和 scripts/grant-plan.ts 完全一致（同一条 SQL），不另写一套。
 */

import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { requirePrincipal } from "@/lib/auth/verify.server";
import { isPlan } from "@/lib/auth/plan";

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  plan: string;
  createdAt: string | null;
  updatedAt: string | null;
};

/** 列全部用户（站长专用）。 */
export const getAdminUsers = createServerFn({ method: "GET" }).handler(async () => {
  const { isOwner } = await requirePrincipal();
  if (!isOwner) throw new Error("只有站长能看用户列表");
  const sql = await getSql();
  const rows = await sql<AdminUser>`select id, email, name, "plan", "createdAt", "updatedAt" from "user" order by "createdAt" desc`;
  return rows;
});

/** 改一个用户的档位（站长专用）。 */
export const setAdminPlan = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { userId?: unknown; plan?: unknown };
    if (typeof d?.userId !== "string" || !d.userId) throw new Error("缺 userId");
    if (!isPlan(d.plan)) throw new Error("档位不合法");
    return { userId: d.userId, plan: d.plan };
  })
  .handler(async ({ data }) => {
    const { isOwner } = await requirePrincipal();
    if (!isOwner) throw new Error("只有站长能改档位");
    const sql = await getSql();
    await sql`update "user" set "plan" = ${data.plan}, "updatedAt" = now() where id = ${data.userId}`;
    return { ok: true };
  });
