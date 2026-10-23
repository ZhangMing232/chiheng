/**
 * 这个文件是干什么的：
 * 取出当前用户。登录关掉时用一个固定的开发用户，登录开着就用真实会话。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

import { authClient, authEnabled } from "./client";

/** Normalized user shape used across the app, auth on or off. */
export type AppUser = {
  id: string;
  displayName: string | null;
  primaryEmail: string | null;
  profileImageUrl: null | string;
  /** 会员档位（design/MEMBERSHIP.md）：free / pro-monthly / pro-yearly / lifetime / admin。
   *  dev 兜底用户恒为 "admin"。 auth 关闭时字段不存在 → null。 */
  plan: string | null;
  /** True when this is the sandbox/dev fallback (auth not configured). */
  isDevFallback: boolean;
};

/**
 * Stable fallback user, used ONLY when auth is disabled
 * (`VITE_AUTH_ENABLED=false`, the shipped default). With auth on, the sandbox
 * live preview does real sign-in via the baked preview client. Its id is
 * `"dev-user"` — the SAME id `verify.server.ts` returns server-side — so per-user
 * rows written in that mode belong to one consistent owner.
 */
export const DEV_USER: AppUser = {
  id: "dev-user",
  displayName: "Dev User",
  primaryEmail: "dev@example.com",
  profileImageUrl: null,
  plan: "admin",
  isDevFallback: true,
};

/** `useCurrentUserState()` result: the user plus the session-loading flag. */
export type CurrentUserState = {
  /** The user — `null` BOTH while the session loads and when signed out. */
  user: AppUser | null;
  /** True while the session is still resolving — don't treat `user: null` as signed out yet. */
  isPending: boolean;
};

/**
 * Current user + loading state. Same behavior in live preview and when deployed:
 *   - Auth enabled -> the real signed-in user; `user` is `null` while
 *                            the session resolves (`isPending: true`) and when
 *                            signed out (`isPending: false`). Session comes from
 *                            Better Auth `useSession()` → `/api/auth/get-session`
 *                            (cookie when deployed; bearer in live preview).
 *   - Auth disabled (`VITE_AUTH_ENABLED=false`) -> `DEV_USER`, never pending.
 *
 * Protect a route by waiting out `isPending` before acting on `user` —
 * redirecting on `user: null` alone bounces signed-in visitors to sign-in on
 * every hard reload:
 *
 *   import { RedirectToSignIn } from "@/lib/auth/gates";
 *   const { user, isPending } = useCurrentUserState();
 *   if (isPending) return null;              // still resolving — don't redirect yet
 *   if (!user) return <RedirectToSignIn />;  // definitely signed out
 *
 * `authEnabled` is a module-level constant fixed at load, so the guarded hook
 * call keeps a stable hook order across every render of a given component.
 */
export function useCurrentUserState(): CurrentUserState {
  if (!authEnabled) return { user: DEV_USER, isPending: false };
  // ⚠️ **这是有意的条件 Hook**：authEnabled 关掉时走不到 useSession。
  // 安全的前提是 authEnabled 在应用生命周期内不变（它来自构建期环境变量）。
  // 哪天它变成运行时开关，这里会抛「Rendered fewer hooks than expected」——
  // 到时候要改成「两个分支都调 Hook、只是参数不同」。
  // （原来这里挂着 eslint-disable rules-of-hooks，但那个规则认不出
  // `authClient.useSession()` 这种成员调用，指令被判「unused」——所以改成普通注释，
  // 风险说明不丢，也不留一条永远不生效的 disable。）
  const { data, isPending } = authClient.useSession();
  const user = data?.user;
  return {
    user: user
      ? {
          id: user.id,
          displayName: user.name ?? null,
          primaryEmail: user.email ?? null,
          profileImageUrl: user.image ?? null,
          // additionalFields（server.ts）透传：会话里的 user 直接带 plan。
          plan: typeof (user as unknown as { plan?: unknown }).plan === "string" ? (user as unknown as { plan: string }).plan : "free",
          isDevFallback: false,
        }
      : null,
    isPending,
  };
}

/**
 * Convenience view of `useCurrentUserState().user` for display (e.g.
 * `user?.displayName ?? "Guest"`). NOTE: `null` means *loading OR signed out* —
 * for redirects/guards use `useCurrentUserState()` and check `isPending`.
 */
export function useCurrentUser(): AppUser | null {
  return useCurrentUserState().user;
}
