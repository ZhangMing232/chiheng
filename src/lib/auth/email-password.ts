/**
 * 这个文件是干什么的：
 * 邮箱加密码这种登录方式的开关，默认是关的。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

/**
 * Local email/password sign-in (this app's Better Auth DB — not the broker).
 *
 * 赤轨自用：2026-10-21 起常开（design/MEMBERSHIP.md 会员体系的基础——
 * 注册登录是收会员费的前提）。注册/登录表单见 /login 页，
 * 调 authClient.signUp.email / authClient.signIn.email（@/lib/auth/client）。
 *
 * Do NOT edit `server.ts` for this — that file is frozen pre-wired config.
 */
export const emailAndPasswordEnabled = true;
