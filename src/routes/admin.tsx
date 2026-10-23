/**
 * 这个文件是干什么的：
 * 「管理系统」页（/admin）——站长专用：列用户、改档位。
 *
 * 你需要知道的：
 * - 只有 plan === "admin" 能看能改；非站长进来显示无权限。
 * - 本机内存 PGLite 下用户重启即清空，要真用必须挂 Neon（DATABASE_URL）。
 * - 改档位走 setAdminPlan（和 grant-plan.ts 同一条 SQL）。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getAdminUsers, setAdminPlan, type AdminUser } from "@/lib/market/admin.functions";
import { PLAN_LABELS, PLANS, type Plan } from "@/lib/auth/plan";

export const Route = createFileRoute("/admin")({
  loader: async () => {
    try {
      return await getAdminUsers();
    } catch {
      return null;
    }
  },
  component: AdminPage,
});

function AdminPage() {
  const initial = Route.useLoaderData();
  const [users, setUsers] = useState<AdminUser[] | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function changePlan(user: AdminUser, plan: Plan) {
    if (plan === user.plan) return;
    setBusy(user.id);
    setError(null);
    try {
      await setAdminPlan({ data: { userId: user.id, plan } });
      setUsers((prev) => (prev ? prev.map((u) => (u.id === user.id ? { ...u, plan } : u)) : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame
      aside="管理系统"
      status={{
        label: "用户",
        // **真实数据**：本页已有的 users 长度。users 为 null 表示还没加载出来，
        // 那就不显示药丸（null ≠ 0）。
        value: users ? `${users.length} 人` : null,
        tone: "neutral",
      }}
    >
      <Panel title="用户管理" note="站长专用 · 改档位即时生效">
        {users === null ? (
          <StateBlock kind="empty" title="无权限" hint="只有站长（plan=admin）能看这个页面。本机内存库重启后用户清空，要真用请挂 Neon。" />
        ) : users.length === 0 ? (
          <StateBlock kind="empty" title="还没有注册用户" hint="开放 /login 注册后，这里会列出所有用户。" />
        ) : (
          <>
            {error ? <p className="px-3.5 py-2 text-[12px] text-down">{error}</p> : null}
            <table className="data-table w-full">
              <caption className="sr-only">用户列表</caption>
              <thead>
                <tr className="border-b border-line">
                  <th className={tdClass("text-left")}>邮箱</th>
                  <th className={tdClass("text-left")}>昵称</th>
                  <th className={tdClass("text-left")}>注册时间</th>
                  <th className={tdClass()}>当前档位</th>
                  <th className={tdClass()}>改为</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-line/60">
                    <td className={tdClass("text-left text-fg")}>{u.email}</td>
                    <td className={tdClass("text-left text-muted")}>{u.name || "—"}</td>
                    <td className={tdClass("text-left text-muted")}>{u.createdAt ? new Date(u.createdAt).toLocaleDateString("zh-CN") : "—"}</td>
                    <td className={tdClass("text-center text-fg")}>{PLAN_LABELS[(u.plan as Plan) ?? "free"] ?? u.plan}</td>
                    <td className={tdClass("text-center")}>
                      <select
                        value={u.plan}
                        disabled={busy === u.id}
                        onChange={(e) => void changePlan(u, e.target.value as Plan)}
                        className="rounded border border-line bg-transparent px-2 py-1 text-xs text-fg"
                      >
                        {PLANS.map((p) => (
                          <option key={p} value={p}>
                            {PLAN_LABELS[p]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>
    </Frame>
  );
}
