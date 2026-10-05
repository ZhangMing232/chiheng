/**
 * 这个文件是干什么的：
 * 判断「这台机器上能不能用共享的 dev 用户」，也就是没有登录这回事的时候
 * 让服务照常跑，而不是每个请求都抛 Unauthorized。
 *
 * 你需要知道的：
 * 2026-10-05 下午，页面上的账本全是 0（持仓 0 只、累计收益 —），看着像数据丢了。
 * 真实原因是 `requireUserId()` 每次都抛：OAuth 没配（这台机器上没有 .env），
 * 而 gateIdentityEnabled() 在变量缺失时返回 true（`!== "false"`），
 * 于是「显式关掉登录」那条分支永远进不去。服务端账本其实好好地在那儿，2 天 71 笔。
 *
 * 抽成纯函数是为了能自动测：verify.server.ts 用的是无扩展名的相对 import，
 * node 的 --experimental-strip-types 加载不了，测试碰不到它。
 */

export type DevUserPolicyInput = {
  /** OAuth 有没有配。没配就意味着这里根本没有登录这回事。 */
  authConfigured: boolean;
  /** 背后有没有真数据库。 */
  databaseConfigured: boolean;
  /** 沙箱那套身份闸门这次请求有没有带上人。 */
  hasRealIdentity: boolean;
};

/**
 * 能不能落到共享的 dev 用户。
 *
 * 两个条件都要满足：
 * - 没配 OAuth：不然就有真正的登录流程，只是这次没登录
 * - 没有真数据库：这是安全线。对着真数据库让所有人共用一个身份绝对不行，
 *   宁可整个请求失败
 *
 * 沙箱预览那种带身份头的场合 `hasRealIdentity` 为真，压根不会走到这里。
 */
export function mayUseDevUser(input: DevUserPolicyInput): boolean {
  if (input.hasRealIdentity) return false;
  if (input.databaseConfigured) return false;
  return !input.authConfigured;
}
