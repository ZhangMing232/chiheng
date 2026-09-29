/**
 * 这个文件是干什么的：
 * 记一个小标记：这次登录是平台自动带进来的。这种会话不显示退出按钮。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

/**
 * Client-readable marker for gate-materialized sessions ("Sign in with Grok"
 * zero-click sessions minted by `gate-session.server.ts`). Signing out of a
 * gate session is a no-op — the next request re-materializes it from
 * `x-grok-identity` — so `UserButton` uses this to hide its sign-out control.
 * `__Host-` prefixed like the other auth cookies: browsers reject a `__Host-`
 * cookie carrying a `Domain`, so an untrusted sibling `*.grok.me` app cannot
 * plant a parent-domain copy that the host-only clear could never expire.
 * Client-safe: no server imports.
 */
export const GATE_SESSION_MARKER_COOKIE = "__Host-grok_gate_session";

export function hasGateSessionMarker(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((pair) => pair.trim().startsWith(`${GATE_SESSION_MARKER_COOKIE}=`));
}
